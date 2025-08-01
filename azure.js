const { NetworkManagementClient } = require('@azure/arm-network')
const { DefaultAzureCredential } = require('@azure/identity')
const { ComputeManagementClient } = require('@azure/arm-compute')
const getLocalIps = require('./get-local-ips')

// Configuration constants
const MAX_RETRIES = 20
const INITIAL_RETRY_DELAY = 5 // seconds
const MAX_RETRY_DELAY = 300 // seconds (5 minutes)
const DEFAULT_UPDATE_INTERVAL = 60 // seconds
const DEFAULT_AZURE_RETRY = 120 // seconds

if (!process.env['AZURE_SUBSCRIPTION_ID']) {
  throw new Error('Please set the AZURE_SUBSCRIPTION_ID environment variable')
}

const subscriptionId = process.env['AZURE_SUBSCRIPTION_ID']
let intervalHandle = null
let errorCounter = 0

module.exports = (args, sendTo) => {
  if (!args.azure) {
    throw new Error('Azure resource group name is required')
  }

  let previousIps = []
  let currentRetryDelay = INITIAL_RETRY_DELAY
  args.interval = args.interval || DEFAULT_UPDATE_INTERVAL
  args.azureRetry = args.azureRetry || DEFAULT_AZURE_RETRY


  const getNextRetryDelay = () => {
    const jitter = Math.random() * 0.3 + 0.85 // Random factor between 0.85 and 1.15
    currentRetryDelay = Math.min(currentRetryDelay * 2 * jitter, MAX_RETRY_DELAY)
    return currentRetryDelay
  }

  // Reset retry mechanism
  const resetRetryMechanism = () => {
    errorCounter = 0
    currentRetryDelay = INITIAL_RETRY_DELAY
  }

  // Update IP mappings
  const updateSendTo = (ips) => {
    // Remove existing mappings
    previousIps.forEach((addr) => {
      delete sendTo[addr]
    })

    // Add new mappings
    ips.forEach((addr) => {
      sendTo[addr] = args.uport
    })

    previousIps = ips
  }

  const processInterfaces = async (client, interfaces, ips, localIps) => {
    try {
      for await (const networkInterface of interfaces) {
        if (networkInterface.virtualMachine) {
          networkInterface.ipConfigurations.forEach(config => {
            if (!localIps.includes(config.privateIPAddress)) {
              ips.push(config.privateIPAddress)
            }
          })
        }
      }
      updateSendTo(ips)
    } catch (error) {
      console.error('Error processing interfaces:', error)
      throw error
    }
  }

  // Process single VMSS
  const processVirtualMachineScaleSet = async (client, ips, localIps, vmssName) => {
    try {
      const networkInterfaces = await client.networkInterfaces.listVirtualMachineScaleSetNetworkInterfaces(
        args.azure,
        vmssName
      )
      
      const collectedInterfaces = []
      for await (const networkInterface of networkInterfaces) {
        collectedInterfaces.push(networkInterface)
      }
      
  
      collectedInterfaces.forEach(networkInterface => {
        if (networkInterface.ipConfigurations) {
          networkInterface.ipConfigurations.forEach(ip => {
            if (!localIps.includes(ip.privateIPAddress)) {
              ips.push(ip.privateIPAddress)
            }
          })
        }
      })
      
      // Only update send-to mappings once we have all IPs
      updateSendTo(ips)
    } catch (error) {
      if (error.code === 'ParentResourceNotFound') {
        console.log(`VMSS ${vmssName} not found - skipping`)
        return
      }
      console.error(`Error processing VMSS ${vmssName}:`, error)
      throw error
    }
  }

  const getVMDetailsByTag = async (tagKey, tagValue) => {
    try {
      const credential = new DefaultAzureCredential()
      const client = new ComputeManagementClient(credential, subscriptionId)
      const vmssCollection = client.virtualMachineScaleSets.listAll()
      const filteredVMSS = []
      for await (const vmss of vmssCollection) {
        if (vmss.tags && vmss.tags[tagKey] === tagValue) {
          filteredVMSS.push(vmss.name)
        }
      }
      return filteredVMSS
    } catch (error) {
      console.error('Error getting VM details by tag:', error)
      throw error
    }
  }

  const processMultipleVirtualMachineScaleSets = async (client, ips, localIps, tagKey, tagValue) => {
    try {
      const filteredVMSS = await getVMDetailsByTag(tagKey, tagValue)
      const requests = filteredVMSS.map(vmssName => processVirtualMachineScaleSet(client, ips, localIps, vmssName))
      await Promise.allSettled(requests)
      updateSendTo(ips)
    } catch (error) {
      console.error('Error processing multiple VMSS:', error)
      throw error
    }
  }


  const updateFunc = async () => {
    try {
      const credential = new DefaultAzureCredential()
      const client = new NetworkManagementClient(credential, subscriptionId)
      const ips = []
      const localIps = getLocalIps()

      if (args.vmss) {
        await processVirtualMachineScaleSet(client, ips, localIps, args.vmss)
      } else if (args.vmssTag) {
        const vmssTagInfo = args.vmssTag.filter(keyVal => keyVal.trim())
        if (vmssTagInfo.length != 2) {
          throw new Error('Please provide vmss proper tag key and value both')
        }
        await processMultipleVirtualMachineScaleSets(client, ips, localIps, vmssTagInfo[0], vmssTagInfo[1])
      } else {
        const interfaces = client.networkInterfaces.list(args.azure)
        await processInterfaces(client, interfaces, ips, localIps)
      }
      resetRetryMechanism()
      
      if (!intervalHandle) {
        intervalHandle = setInterval(updateFunc, args.interval * 1000)
      }
    } catch (error) {
      console.error('Azure connection error:', error)
      errorCounter++
      
      if (errorCounter > MAX_RETRIES) {
        console.error(`Max retries (${MAX_RETRIES}) exceeded. Giving up.`)
        return
      }
      
      if (intervalHandle) {
        clearInterval(intervalHandle)
        intervalHandle = null
      }
      
  
      const retryDelay = getNextRetryDelay()
      console.log(`Retrying in ${retryDelay} seconds (attempt ${errorCounter + 1}/${MAX_RETRIES})...`)
      
      intervalHandle = setTimeout(updateFunc, retryDelay * 1000)
    }
  }

  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error)
    if (intervalHandle) {
      clearInterval(intervalHandle)
      intervalHandle = null
    }
    process.exit(1)
  })

  updateFunc()

  // Return cleanup function
  return () => {
    if (intervalHandle) {
      clearInterval(intervalHandle)
      intervalHandle = null
    }
  }
}
