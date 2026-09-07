$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$helmImage = "alpine/helm:3.18.6"
$azureCliImage = "mcr.microsoft.com/azure-cli:2.77.0"
$tofuImage = "ghcr.io/opentofu/opentofu:1.10.6"

function Invoke-Docker {
    param([string[]]$Arguments)

    & docker @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "docker $($Arguments -join ' ') failed"
    }
}

function Invoke-DockerQuiet {
    param([string[]]$Arguments)

    & docker @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "docker $($Arguments -join ' ') failed"
    }
}

function Assert-HelmTemplateFails {
    param(
        [string[]]$AdditionalArguments,
        [string]$ExpectedMessage
    )

    $arguments = @(
        "run", "--rm",
        "--volume", "${chart}:/chart",
        $helmImage,
        "template", "invalid", "/chart",
        "--set", "image.tag=validation"
    ) + $AdditionalArguments
    $output = (& docker @arguments 2>&1) -join "`n"
    if ($LASTEXITCODE -eq 0) {
        throw "Helm unexpectedly accepted an invalid remote MCP configuration."
    }
    if (-not $output.Contains($ExpectedMessage)) {
        throw "Helm failed without the expected message: $ExpectedMessage"
    }
}

$chart = Join-Path $root "deploy\kubernetes\helm\agentic-data-kernel"
Invoke-DockerQuiet @(
    "run", "--rm",
    "--volume", "${chart}:/chart",
    $helmImage,
    "lint", "/chart",
    "--set", "image.tag=validation"
)
$templateArguments = @(
    "run", "--rm",
    "--volume", "${chart}:/chart",
    $helmImage,
    "template", "agentic-data", "/chart",
    "--namespace", "agentic-data",
    "--set", "image.tag=validation",
    "--set", "ingress.enabled=true",
    "--set", "ingress.tls[0].secretName=validation-tls",
    "--set", "ingress.tls[0].hosts[0]=agentic-data.example.com",
    "--set-string", "ingress.tlsOnlyAnnotation=nginx.ingress.kubernetes.io/ssl-redirect",
    "--set-string", "ingress.tlsOnlyValue=true",
    "--set-string", "config.trustedProxyHops=1",
    "--set-string", "config.mcpHttpEnabled=true",
    "--set-string", "config.mcpHttpPublicOrigin=https://agent-data.example.com",
    "--set", "databaseProxy.enabled=true",
    "--set", "databaseProxy.image=database-proxy:validation",
    "--set-string", "databaseProxy.args[0]=--private-ip",
    "--set-string", "databaseProxy.args[1]=project:region:instance"
)
$rendered = & docker @templateArguments
if ($LASTEXITCODE -ne 0) {
    throw "Helm template rendering failed"
}
$renderedText = $rendered -join "`n"
$manifestExpectations = @{
    "name: DATABASE_URL" = 2
    "name: MIGRATION_DATABASE_URL" = 2
    "name: APP_DATABASE_PASSWORD" = 1
    "restartPolicy: Always" = 4
    "name: database-proxy-ready" = 4
    "MCP_HTTP_ENABLED: `"true`"" = 1
    "MCP_HTTP_PUBLIC_ORIGIN: `"https://agent-data.example.com`"" = 1
}
foreach ($expectation in $manifestExpectations.GetEnumerator()) {
    $matches = [regex]::Matches(
        $renderedText,
        [regex]::Escape($expectation.Key)
    ).Count
    if ($matches -ne $expectation.Value) {
        throw (
            "Rendered Helm manifests contain $matches instances of " +
            "$($expectation.Key); expected $($expectation.Value)"
        )
    }
}
Assert-HelmTemplateFails `
    @("--set-string", "config.mcpHttpEnabled=true") `
    "config.mcpHttpPublicOrigin is required"
Assert-HelmTemplateFails `
    @(
        "--set-string", "config.mcpHttpEnabled=true",
        "--set-string", "config.mcpHttpPublicOrigin=https://agent-data.example.com/mcp"
    ) `
    "must be an HTTPS DNS origin with an optional port from 1 through 65535"
Assert-HelmTemplateFails `
    @(
        "--set-string", "config.mcpHttpEnabled=true",
        "--set-string", "config.mcpHttpPublicOrigin=https://agent-data.example.com:abc"
    ) `
    "must be an HTTPS DNS origin with an optional port from 1 through 65535"
Assert-HelmTemplateFails `
    @(
        "--set-string", "config.mcpHttpEnabled=true",
        "--set-string", "config.mcpHttpPublicOrigin=https://agent-data.example.com:65536"
    ) `
    "must be an HTTPS DNS origin with an optional port from 1 through 65535"
Assert-HelmTemplateFails `
    @("--set-string", "config.mcpHttpPublicOrigin=https://agent-data.example.com?tenant=a") `
    "must be an HTTPS DNS origin with an optional port from 1 through 65535"
Assert-HelmTemplateFails `
    @("--set-string", "config.mcpHttpPublicOrigin=https://user@agent-data.example.com") `
    "must be an HTTPS DNS origin with an optional port from 1 through 65535"
Assert-HelmTemplateFails `
    @("--set-string", "config.mcpHttpPublicOrigin=http://agent-data.example.com") `
    "must be an HTTPS DNS origin with an optional port from 1 through 65535"
Assert-HelmTemplateFails `
    @("--set-string", "config.mcpHttpWriteEnabled=true") `
    "config.mcpHttpWriteEnabled requires config.mcpHttpEnabled"

$azure = Join-Path $root "deploy\azure"
[scriptblock]::Create(
    (Get-Content (Join-Path $azure "deploy.ps1") -Raw)
) | Out-Null
$azureSource = Get-Content (Join-Path $azure "main.bicep") -Raw
foreach ($message in @(
    "mcpHttpPublicHostname is required when mcpHttpEnabled is true",
    "mcpHttpPublicHostname must be a valid DNS hostname without a scheme, port, path, query, or credentials",
    "mcpHttpWriteEnabled requires mcpHttpEnabled"
)) {
    if (-not $azureSource.Contains("fail('$message')")) {
        throw "Azure Bicep is missing remote MCP validation: $message"
    }
}
Invoke-DockerQuiet @(
    "run", "--rm",
    "--volume", "${azure}:/src",
    $azureCliImage,
    "az", "bicep", "build",
    "--file", "/src/main.bicep",
    "--stdout"
)

$digest = "sha256:$("a" * 64)"
$digestArguments = @(
    "run", "--rm",
    "--volume", "${chart}:/chart",
    $helmImage,
    "template", "agentic-data-digest", "/chart",
    "--namespace", "agentic-data",
    "--set", "image.tag=",
    "--set", "image.digest=$digest"
)
$digestRendered = (& docker @digestArguments) -join "`n"
if ($LASTEXITCODE -ne 0) {
    throw "Helm digest rendering failed"
}
if (-not $digestRendered.Contains("@$digest")) {
    throw "Helm digest rendering did not use OCI digest syntax"
}
foreach ($directory in @("aws", "gcp")) {
    $module = Join-Path $root "deploy\$directory"
    $variablesSource = Get-Content (Join-Path $module "variables.tf") -Raw
    foreach ($contract in @(
        'var.mcp_http_public_origin == ""',
        '6553[0-5]',
        'mcp_http_public_origin is required when mcp_http_enabled is true',
        'mcp_http_write_enabled requires mcp_http_enabled'
    )) {
        if (-not $variablesSource.Contains($contract)) {
            throw "$directory OpenTofu is missing remote MCP validation: $contract"
        }
    }
    try {
        Invoke-Docker @(
            "run", "--rm",
            "--volume", "${module}:/work",
            "--workdir", "/work",
            $tofuImage,
            "fmt", "-check", "-recursive"
        )
        Invoke-Docker @(
            "run", "--rm",
            "--volume", "${module}:/work",
            "--workdir", "/work",
            $tofuImage,
            "init", "-backend=false", "-input=false"
        )
        Invoke-Docker @(
            "run", "--rm",
            "--volume", "${module}:/work",
            "--workdir", "/work",
            $tofuImage,
            "validate"
        )
    }
    finally {
        Invoke-DockerQuiet @(
            "run", "--rm",
            "--volume", "${module}:/work",
            "--workdir", "/work",
            "--entrypoint", "sh",
            $tofuImage,
            "-c", "rm -rf /work/.terraform"
        )
    }
}

Write-Output "Deployment templates validated."
