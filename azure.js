const MsRest = require('ms-rest-azure')
const NetworkManagementClient = require('azure-arm-network')
const getLocalIps = require('./get-local-ips')

if (!process.env['AZURE_SUBSCRIPTION_ID']) {
  throw new Error('Please set the AZURE_SUBSCRIPTION_ID environment variable')
}
const subscriptionId = process.env['AZURE_SUBSCRIPTION_ID']

module.exports = (args, sendTo) => {
  let previousIps = []

  const updateSendTo = function (ips) {
    // Remove existing.
    previousIps.forEach((addr) => {
      delete sendTo[addr]
    })

    // Insert new.
    ips.forEach((addr) => {
      sendTo[addr] = args.uport
    })

    previousIps = ips
  }

  const processInterfaces = function (client, interfaces, ips, localIps) {
    interfaces.forEach(networkInterface => {
      if (networkInterface.virtualMachine) {
        networkInterface.ipConfigurations.forEach(config => {
          if (!localIps.includes(config.privateIPAddress)) {
            ips.push(config.privateIPAddress)
          }
        })
      }
    })
    if (interfaces.nextLink) {
      client.networkInterfaces.listNext(interfaces.nextLink).then(interfaces => {
        processInterfaces(client, interfaces, ips, localIps)
      })
    } else {
      updateSendTo(ips)
    }
  }

  const processVirtualMachineScaleSet = function (client, ips, localIps, vmssName) {
    client.networkInterfaces._listVirtualMachineScaleSetNetworkInterfaces(args.azure, vmssName, function(err, results) {
      if (err) {
        console.log(err);
        return;
      }

      results.forEach(result => {
        result.ipConfigurations.forEach(ip => {
          if (!localIps.includes(ip.privateIPAddress)) {
            ips.push(ip.privateIPAddress)
          }
        })
      })

      updateSendTo(ips)
    })
  }

  const processVirtualMachineScaleSetPromise = function (
    client,
    ips,
    localIps,
    vmssName,
    vmssNameList
  ) {
    return new Promise((resolve, reject) => {
      client.networkInterfaces._listVirtualMachineScaleSetNetworkInterfaces(
        args.azure,
        vmssName,
        function (err, results) {
          if (err) {
            // Do Nothing if the VMSS is deleted, so than for next deployment inter VMSS forwarding will work
            if (
              err.message !==
              `Can not perform requested operation on nested resource. Parent resource '${vmssName}' not found.`
            ) {
              console.log(err)
            }
            resolve(null)
          }
          resolve(results)
        }
      )
    })
  }

  const processMultipleVirtualMachineScaleSets = function (
    client,
    ips,
    localIps,
    vmssNameList
  ) {
    const requests = vmssNameList.map((vmssName) => {
      return new Promise(async resolve => {
        const results = await processVirtualMachineScaleSetPromise(client, ips, localIps, vmssName, vmssNameList)
        if (results && results.length) {
          results.forEach(result => {
            result.ipConfigurations.forEach(ip => {
              if (!localIps.includes(ip.privateIPAddress)) {
                ips.push(ip.privateIPAddress)
              }
            })
          })
          resolve(ips)
        }
        resolve([])
      })
    })

    Promise.allSettled(requests).then((result) => {
      updateSendTo(ips)
    })
  }

  const updateFunc = () => {
    MsRest.loginWithVmMSI().then(credentials => {
      let client = new NetworkManagementClient(credentials, subscriptionId)
      const ips = []

      if (typeof args.vmss !== 'undefined' && args.vmss) {
        processVirtualMachineScaleSet(client, ips, getLocalIps(), args.vmss)
      } else if (typeof args.vmssList !== 'undefined' && args.vmssList) {
        const vmssList = args.vmssList.filter(vm => vm.trim())
        processMultipleVirtualMachineScaleSets(client, ips, getLocalIps(), vmssList)
      } else {
        client.networkInterfaces.list(args.azure).then(interfaces => {
          processInterfaces(client, interfaces, ips, getLocalIps())
        })
      }
    })
  }

  updateFunc()

  setInterval(updateFunc, args.interval * 1000)
}
