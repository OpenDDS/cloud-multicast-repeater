const MsRest = require('ms-rest-azure')
const NetworkManagementClient = require('azure-arm-network')
const { DefaultAzureCredential } = require("@azure/identity")
const { ComputeManagementClient } = require("@azure/arm-compute")
const getLocalIps = require('./get-local-ips')

if (!process.env['AZURE_SUBSCRIPTION_ID']) {
  throw new Error('Please set the AZURE_SUBSCRIPTION_ID environment variable')
}
const subscriptionId = process.env['AZURE_SUBSCRIPTION_ID']
let intervalHandle = null;
let errorCounter = 0;

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
    client.networkInterfaces
      ._listVirtualMachineScaleSetNetworkInterfaces(args.azure, vmssName,
        function (err, results) {
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
    vmssName
  ) {
    return new Promise((resolve, reject) => {
      client.networkInterfaces._listVirtualMachineScaleSetNetworkInterfaces(
        args.azure,
        vmssName,
        function (err, results) {
          if (err) {
            // Do nothing if the VMSS is deleted, so that for next deployment inter VMSS forwarding will work
            if (err.code !== 'ParentResourceNotFound') {
              console.log(err)
            }
            resolve(null)
          }
          resolve(results)
        }
      )
    })
  }

  async function getVMDetailsByTag(tagKey, tagValue) {

    const credential = new DefaultAzureCredential();

    const client = new ComputeManagementClient(credential, subscriptionId);

    const vmss = await client.virtualMachineScaleSets.listAll().byPage().next();

    return vmss.value
      .filter(vms => vms.tags && vms.tags[tagKey] === tagValue)
      .map(vms => vms.name);

  }

  const processMultipleVirtualMachineScaleSets = function (
    client,
    ips,
    localIps,
    tagKey,
    tagValue
  ) {
    getVMDetailsByTag(tagKey, tagValue).then(filteredVMSS => {
      const requests = filteredVMSS.map((vmssName) => {
        return new Promise(async resolve => {
          const results = await processVirtualMachineScaleSetPromise(client, vmssName)
          if (results && results.length) {
            results.forEach(result => {
              result.ipConfigurations.forEach(ip => {
                if (!localIps.includes(ip.privateIPAddress)) {
                  ips.push(ip.privateIPAddress)
                }
              })
            })
            return resolve(ips)
          }
          resolve([])
        })
      })
      Promise.allSettled(requests).then((result) => {
        updateSendTo(ips)
      })
    }).catch(err => {
      console.error("An error occurred:", err);
    });
  }

  const updateFunc = () => {
    MsRest.loginWithVmMSI().then(credentials => {
      let client = new NetworkManagementClient(credentials, subscriptionId)
      const ips = []

      if (typeof args.vmss !== 'undefined' && args.vmss) {
        processVirtualMachineScaleSet(client, ips, getLocalIps(), args.vmss)
      } else if (typeof args.vmssTag !== 'undefined' && args.vmssTag) {
        const vmssTagInfo = args.vmssTag.filter(keyVal => keyVal.trim())
        if (vmssTagInfo.length != 2)
          throw new Error('Please provide vmss proper tag key and value both');
        processMultipleVirtualMachineScaleSets(client, ips, getLocalIps(), vmssTagInfo[0], vmssTagInfo[1])
      } else {
        client.networkInterfaces.list(args.azure).then(interfaces => {
          processInterfaces(client, interfaces, ips, getLocalIps())
        })
      }
      errorCounter = 0;
      if(intervalHandle == null)
        intervalHandle = setInterval(updateFunc, args.interval * 1000)
    })
    .catch((err) => {
      console.log(err);
      errorCounter++;
      if (errorCounter > 10)
        throw new Error(
          "Failed to communicate with azure API"
        );
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
      setTimeout(() => {
        updateFunc();
      }, args.azureRetry * 1000);
    });
  }

  updateFunc()

  setInterval(updateFunc, args.interval * 1000)
}
