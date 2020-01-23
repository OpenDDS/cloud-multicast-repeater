# OpenDDS-Repeater
JavaScript implementation of the multicast repeater

```markdown
docker build -t repeater:v1
```

```markdown
docker run \
    -d \
    --name=repeater \
    --rm \
    -e AZURE_SUBSCRIPTION_ID=7790fd1c-f902-470d-893a-3ce442a7f0e5 \
    --net=host \
    repeater:v1 /usr/src/app/repeater.js \
    --group 239.255.0.1:8400 \
    --uport 5000 \
    --v \
    --azure rtpsResourceGroup 
```

```markdown
docker container exec -it repeater /bin/bash

docker login --username=yourhubusername --email=youremail@company.com

$ docker push objectcomputing/repeater:v1
```

Test to see that the repeater is working
```markdown
sudo apt install smcroute
sudo tcpdump -i eth0 -n udp port 5000
mcsender -t3 239.255.0.1:8400
```

cloud-multicast-repeater

```markdown

/Users/wilsonj/OpenDDS/OpenDDS/rtps-relay-participant/bin/RtpsRelay -DCPSConfigFile relay1.ini -ApplicationDomain 42 -RelayDomain 0


```
