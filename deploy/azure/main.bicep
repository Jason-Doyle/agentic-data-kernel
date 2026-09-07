targetScope = 'resourceGroup'

@description('Azure region for the Container Apps workloads.')
param location string = resourceGroup().location

@minLength(2)
@maxLength(21)
@description('Lowercase alphanumeric and hyphen prefix used for workload names.')
param namePrefix string = 'agentic-data'

@description('Immutable Agentic Data Kernel image tag or digest.')
param image string

@description('Existing Azure Container Apps managed environment resource ID.')
param managedEnvironmentId string

@description('Existing managed-environment storage link backed by Azure Files NFS.')
param artifactStorageName string

@description('Runtime identity allowed to read only API and worker secrets.')
param runtimeIdentityResourceId string

@description('Administrative job identity allowed to read bootstrap and migration secrets.')
param adminIdentityResourceId string

@description('Key Vault secret URL containing the agentic_app DATABASE_URL.')
param databaseUrlSecretUrl string

@description('Key Vault secret URL containing the administrative MIGRATION_DATABASE_URL.')
param migrationDatabaseUrlSecretUrl string

@description('Key Vault secret URL containing APP_DATABASE_PASSWORD.')
param appDatabasePasswordSecretUrl string

@description('Optional Key Vault secret URL containing DATABASE_CA_CERT_BASE64.')
param databaseCaSecretUrl string = ''

@description('Key Vault secret URL containing AUTH_PEPPER.')
param authPepperSecretUrl string

@description('Key Vault secret URL containing ARTIFACT_KEYRING.')
param artifactKeyringSecretUrl string

@description('Key Vault secret URL containing EMBEDDING_API_KEY.')
param embeddingApiKeySecretUrl string

@description('OpenAI-compatible embeddings endpoint.')
param embeddingBaseUrl string

param embeddingModel string = 'text-embedding-3-small'
param embeddingVersion string = 'openai-compatible-v1'
param artifactCurrentKeyId string = 'v1'

@minValue(1)
@maxValue(2000)
param embeddingDimensions int = 1536

@description('Comma-separated HTTPS hosts allowed for external effects.')
param effectAllowedHosts string = ''

@description('Expose authenticated Streamable HTTP MCP at /mcp.')
param mcpHttpEnabled bool = false

@description('Exact public DNS hostname used to construct the remote MCP HTTPS origin.')
param mcpHttpPublicHostname string = ''

@description('Expose execute_operation through remote MCP. Keep false for read-only agents.')
param mcpHttpWriteEnabled bool = false

var mcpHttpHostnameLabels = split(mcpHttpPublicHostname, '.')
var invalidMcpHttpHostnameLabels = filter(
  mcpHttpHostnameLabels,
  label => empty(label) || length(label) > 63 || startsWith(label, '-') || endsWith(label, '-')
)
var invalidMcpHttpHostnameCharacters = filter(
  range(0, length(mcpHttpPublicHostname)),
  index => !contains('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-.', substring(mcpHttpPublicHostname, index, 1))
)
var validatedMcpHttpPublicHostname = empty(mcpHttpPublicHostname)
  ? ''
  : length(mcpHttpPublicHostname) > 253 || length(invalidMcpHttpHostnameLabels) > 0 || length(invalidMcpHttpHostnameCharacters) > 0
    ? fail('mcpHttpPublicHostname must be a valid DNS hostname without a scheme, port, path, query, or credentials')
    : mcpHttpPublicHostname
var validatedMcpHttpPublicOrigin = empty(validatedMcpHttpPublicHostname)
  ? ''
  : 'https://${validatedMcpHttpPublicHostname}'
var validatedMcpHttpEnabled = mcpHttpEnabled && empty(validatedMcpHttpPublicHostname)
  ? fail('mcpHttpPublicHostname is required when mcpHttpEnabled is true')
  : mcpHttpEnabled
var validatedMcpHttpWriteEnabled = mcpHttpWriteEnabled && !validatedMcpHttpEnabled
  ? fail('mcpHttpWriteEnabled requires mcpHttpEnabled')
  : mcpHttpWriteEnabled

@description('Start the API and worker after bootstrap and migration jobs succeed.')
param startWorkloads bool = false

param apiMinReplicas int = 1
param apiMaxReplicas int = 3

var apiName = '${namePrefix}-api'
var workerName = '${namePrefix}-worker'
var bootstrapJobName = '${namePrefix}-bootstrap'
var migrateJobName = '${namePrefix}-migrate'
var artifactMountPath = '/var/lib/agentic-data/artifacts'
var runtimeDatabaseCaSecrets = empty(databaseCaSecretUrl) ? [] : [
  {
    name: 'database-ca-cert'
    keyVaultUrl: databaseCaSecretUrl
    identity: runtimeIdentityResourceId
  }
]
var adminDatabaseCaSecrets = empty(databaseCaSecretUrl) ? [] : [
  {
    name: 'database-ca-cert'
    keyVaultUrl: databaseCaSecretUrl
    identity: adminIdentityResourceId
  }
]
var databaseCaEnvironment = empty(databaseCaSecretUrl) ? [] : [
  {
    name: 'DATABASE_CA_CERT_BASE64'
    secretRef: 'database-ca-cert'
  }
]
var runtimeSecrets = concat([
  {
    name: 'database-url'
    keyVaultUrl: databaseUrlSecretUrl
    identity: runtimeIdentityResourceId
  }
  {
    name: 'auth-pepper'
    keyVaultUrl: authPepperSecretUrl
    identity: runtimeIdentityResourceId
  }
  {
    name: 'artifact-keyring'
    keyVaultUrl: artifactKeyringSecretUrl
    identity: runtimeIdentityResourceId
  }
  {
    name: 'embedding-api-key'
    keyVaultUrl: embeddingApiKeySecretUrl
    identity: runtimeIdentityResourceId
  }
], runtimeDatabaseCaSecrets)
var runtimeEnvironment = concat([
  {
    name: 'DATABASE_URL'
    secretRef: 'database-url'
  }
  {
    name: 'DATABASE_SSL'
    value: 'require'
  }
  {
    name: 'DATABASE_POOL_SIZE'
    value: '10'
  }
  {
    name: 'AUTH_PEPPER'
    secretRef: 'auth-pepper'
  }
  {
    name: 'ARTIFACT_KEYRING'
    secretRef: 'artifact-keyring'
  }
  {
    name: 'ARTIFACT_CURRENT_KEY_ID'
    value: artifactCurrentKeyId
  }
  {
    name: 'ARTIFACT_DIR'
    value: artifactMountPath
  }
  {
    name: 'EMBEDDING_BASE_URL'
    value: embeddingBaseUrl
  }
  {
    name: 'EMBEDDING_API_KEY'
    secretRef: 'embedding-api-key'
  }
  {
    name: 'EMBEDDING_MODEL'
    value: embeddingModel
  }
  {
    name: 'EMBEDDING_VERSION'
    value: embeddingVersion
  }
  {
    name: 'EMBEDDING_DIMENSIONS'
    value: string(embeddingDimensions)
  }
  {
    name: 'EFFECT_ALLOWED_HOSTS'
    value: effectAllowedHosts
  }
  {
    name: 'HOST'
    value: '0.0.0.0'
  }
  {
    name: 'PORT'
    value: '4318'
  }
  {
    name: 'LOG_LEVEL'
    value: 'info'
  }
  {
    name: 'TRUSTED_PROXY_HOPS'
    value: '1'
  }
  {
    name: 'WORKER_MONITOR_HOST'
    value: '0.0.0.0'
  }
  {
    name: 'WORKER_MONITOR_PORT'
    value: '4319'
  }
  {
    name: 'SHUTDOWN_TIMEOUT_MS'
    value: '10000'
  }
  {
    name: 'MCP_HTTP_ENABLED'
    value: string(validatedMcpHttpEnabled)
  }
  {
    name: 'MCP_HTTP_PUBLIC_ORIGIN'
    value: validatedMcpHttpPublicOrigin
  }
  {
    name: 'MCP_HTTP_WRITE_ENABLED'
    value: string(validatedMcpHttpWriteEnabled)
  }
], databaseCaEnvironment)

resource api 'Microsoft.App/containerApps@2025-07-01' = {
  name: apiName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${runtimeIdentityResourceId}': {}
    }
  }
  properties: {
    environmentId: managedEnvironmentId
    configuration: union({
      activeRevisionsMode: 'Single'
      secrets: runtimeSecrets
    }, startWorkloads ? {
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 4318
        transport: 'http'
      }
    } : {})
    template: {
      containers: [
        {
          name: 'api'
          image: image
          command: [
            'node'
            'dist/production/cli.js'
            'serve'
          ]
          env: runtimeEnvironment
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health/live'
                port: 4318
                scheme: 'HTTP'
              }
              initialDelaySeconds: 20
              periodSeconds: 20
              timeoutSeconds: 3
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health/ready'
                port: 4318
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 6
            }
          ]
          volumeMounts: [
            {
              volumeName: 'artifacts'
              mountPath: artifactMountPath
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'artifacts'
          storageName: artifactStorageName
          storageType: 'NfsAzureFile'
        }
      ]
      scale: {
        minReplicas: startWorkloads ? apiMinReplicas : 0
        maxReplicas: apiMaxReplicas
      }
    }
  }
}

resource worker 'Microsoft.App/containerApps@2025-07-01' = {
  name: workerName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${runtimeIdentityResourceId}': {}
    }
  }
  properties: {
    environmentId: managedEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: runtimeSecrets
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: image
          command: [
            'node'
            'dist/production/cli.js'
            'worker'
          ]
          env: runtimeEnvironment
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health/live'
                port: 4319
                scheme: 'HTTP'
              }
              initialDelaySeconds: 20
              periodSeconds: 20
              timeoutSeconds: 3
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health/ready'
                port: 4319
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 6
            }
          ]
          volumeMounts: [
            {
              volumeName: 'artifacts'
              mountPath: artifactMountPath
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'artifacts'
          storageName: artifactStorageName
          storageType: 'NfsAzureFile'
        }
      ]
      scale: {
        minReplicas: startWorkloads ? 1 : 0
        maxReplicas: 1
      }
    }
  }
}

resource bootstrap 'Microsoft.App/jobs@2025-07-01' = {
  name: bootstrapJobName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${adminIdentityResourceId}': {}
    }
  }
  properties: {
    environmentId: managedEnvironmentId
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 900
      replicaRetryLimit: 2
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      secrets: concat([
        {
          name: 'migration-database-url'
          keyVaultUrl: migrationDatabaseUrlSecretUrl
          identity: adminIdentityResourceId
        }
        {
          name: 'app-database-password'
          keyVaultUrl: appDatabasePasswordSecretUrl
          identity: adminIdentityResourceId
        }
      ], adminDatabaseCaSecrets)
    }
    template: {
      containers: [
        {
          name: 'bootstrap'
          image: image
          command: [
            'node'
            'dist/production/cli.js'
            'bootstrap-role'
          ]
          env: concat([
            {
              name: 'MIGRATION_DATABASE_URL'
              secretRef: 'migration-database-url'
            }
            {
              name: 'APP_DATABASE_PASSWORD'
              secretRef: 'app-database-password'
            }
            {
              name: 'DATABASE_SSL'
              value: 'require'
            }
          ], databaseCaEnvironment)
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
    }
  }
}

resource migrate 'Microsoft.App/jobs@2025-07-01' = {
  name: migrateJobName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${adminIdentityResourceId}': {}
    }
  }
  properties: {
    environmentId: managedEnvironmentId
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 900
      replicaRetryLimit: 2
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      secrets: concat([
        {
          name: 'migration-database-url'
          keyVaultUrl: migrationDatabaseUrlSecretUrl
          identity: adminIdentityResourceId
        }
      ], adminDatabaseCaSecrets)
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: image
          command: [
            'node'
            'dist/production/cli.js'
            'migrate'
          ]
          env: concat([
            {
              name: 'MIGRATION_DATABASE_URL'
              secretRef: 'migration-database-url'
            }
            {
              name: 'DATABASE_SSL'
              value: 'require'
            }
            {
              name: 'EMBEDDING_MODEL'
              value: embeddingModel
            }
            {
              name: 'EMBEDDING_VERSION'
              value: embeddingVersion
            }
            {
              name: 'EMBEDDING_DIMENSIONS'
              value: string(embeddingDimensions)
            }
          ], databaseCaEnvironment)
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
    }
  }
}

output apiName string = api.name
output apiFqdn string = startWorkloads ? api.properties.configuration.ingress.fqdn : ''
output bootstrapJobName string = bootstrap.name
output migrateJobName string = migrate.name
output bootstrapCommand string = 'az containerapp job start --resource-group ${resourceGroup().name} --name ${bootstrap.name}'
output migrateCommand string = 'az containerapp job start --resource-group ${resourceGroup().name} --name ${migrate.name}'
