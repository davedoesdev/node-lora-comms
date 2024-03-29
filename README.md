Node.js module for reading and writing LoRa packets. It uses a [shared
library](https://github.com/davedoesdev/packet_forwarder_shared) which
reads and writes packets directly from the LoRa radio to memory. Tested
on a Raspberry Pi 3 Model B with an IMST iC880A-SPI.

You can read and write packets using standard Node.js
[Duplex](https://nodejs.org/dist/latest-v9.x/docs/api/stream.html#stream_class_stream_duplex)
streams.

API documentation is available
[here](http://rawgit.davedoesdev.com/davedoesdev/node-lora-comms/master/docs/index.html).

The packet format is the same as SemTech’s packet forwarder, described
in sections 3-6 of [this
document](https://raw.githubusercontent.com/davedoesdev/packet_forwarder_shared/master/PROTOCOL.TXT).

You can use Anthony Kirby’s excellent [packet decoder and
encoder](https://github.com/anthonykirby/lora-packet) to help parse and
construct packet data.

**For a higher-level LoRa library, with support for over-the-air
activation, try [lorano](https://github.com/davedoesdev/lorano).**

# Example

This program works in conjunction with a [corresponding Arduino
sketch](test/node_lora_comms_test.ino) (tested on a [SODAQ
Explorer](http://support.sodaq.com/sodaq-one/explorer/)).

It reads 12-byte packets from the LoRa radio, leaves the first 6 bytes
unchanged and randomizes the last 6 bytes. It then sends the packet back
to the radio. The Explorer does the same but randomizes the first 6 byes
it receives, leaving the last 6 bytes unchanged.

Each side then checks whether it gets back the bytes it randomized in
the previous packet it sent.

**example.js.**

``` javascript
const lora_comms = require('lora-comms'),
      lora_packet = require('lora-packet'),
      crypto = require('crypto'),
      { Transform } = require('stream'),
      aw = require('awaitify-stream'),
      expect = require('chai').expect,
      PROTOCOL_VERSION = 2,
      pkts = {
          PUSH_DATA: 0,
          PUSH_ACK: 1,
          PULL_DATA: 2,
          PULL_RESP: 3,
          PULL_ACK: 4,
          TX_ACK: 5
      },
      // USE YOUR OWN KEYS!
      DevAddr = Buffer.alloc(4),
      NwkSKey = Buffer.alloc(16),
      AppSKey = Buffer.alloc(16),
      payload_size = 12;

process.on('SIGINT', lora_comms.stop);

lora_comms.start_logging();
lora_comms.log_info.pipe(process.stdout);
lora_comms.log_error.pipe(process.stderr);

lora_comms.start();

async function wait_for(link, pkt) {
    while (true) {
        const data = await link.readAsync();
        if ((data.length >= 4) &&
            (data[0] === PROTOCOL_VERSION) &&
            (data[3] === pkt)) {
            return data;
        }
    }
}

const uplink_out = aw.createWriter(lora_comms.uplink);
const downlink_out = aw.createWriter(lora_comms.downlink);
let received_first_pull_data = false;

function ack(data, _, cb) {
    (async () => {
        if ((data.length >= 4) && (data[0] === PROTOCOL_VERSION)) {
            const type = data[3];
            if (type === pkts.PUSH_DATA) {
                await uplink_out.writeAsync(Buffer.concat([
                    data.slice(0, 3),
                    Buffer.from([pkts.PUSH_ACK])]));
            } else if (type === pkts.PULL_DATA) {
                await downlink_out.writeAsync(Buffer.concat([
                    data.slice(0, 3),
                    Buffer.from([pkts.PULL_ACK])]));

                process.nextTick(() => downlink_in.stream.read(0));

                if (received_first_pull_data) {
                    return cb();
                }
                received_first_pull_data = true;
            }
        }
        cb(null, data);
    })();
}

const uplink_in = aw.createReader(lora_comms.uplink.pipe(
    new Transform({ transform: ack })));
const downlink_in = aw.createReader(lora_comms.downlink.pipe(
    new Transform({ transform: ack })));

(async () => {
    await wait_for(downlink_in, pkts.PULL_DATA);

    let send_payload = crypto.randomBytes(payload_size);
    let count = 0;

    while (true)
    {
        let packet = await wait_for(uplink_in, pkts.PUSH_DATA);
        let payload = JSON.parse(packet.slice(12));
        if (!payload.rxpk) {
            continue;
        }
        for (let rxpk of payload.rxpk)
        {
            let recv_data = Buffer.from(rxpk.data, 'base64');
            let decoded = lora_packet.fromWire(recv_data);
            let buffers = decoded.getBuffers();

            if (!buffers.DevAddr.equals(DevAddr)) {
                continue;
            }

            expect(lora_packet.verifyMIC(decoded, NwkSKey)).to.be.true;

            let recv_payload = lora_packet.decrypt(decoded, AppSKey, NwkSKey);

            if (recv_payload.length !== payload_size) {
                continue;
            }

            if (recv_payload.equals(send_payload)) {
                // Shouldn't happen because send on reverse polarity
                console.error('ERROR: Received packet we sent');
                continue;
            }

            if (recv_payload.compare(send_payload,
                                     payload_size/2,
                                     payload_size,
                                     payload_size/2,
                                     payload_size) === 0) {
                console.log('SUCCESS: Received matching data');
                return lora_comms.stop();
            }

            send_payload = Buffer.concat([recv_payload.slice(0, payload_size/2),
                                          crypto.randomBytes(payload_size/2)]);

            let encoded = lora_packet.fromFields({
                MType: 'Unconfirmed Data Down',
                DevAddr: DevAddr,
                FCnt: count++,
                FCtrl: {
                    ADR: false,
                    ACK: false,
                    ADRACKReq: false,
                    FPending: false
                },
                FPort: 1,
                payload: send_payload
            }, AppSKey, NwkSKey);

            let send_data = encoded.getPHYPayload();

            let header = Buffer.alloc(4);
            header[0] = PROTOCOL_VERSION;
            crypto.randomFillSync(header, 1, 2);
            header[3] = pkts.PULL_RESP;

            let txpk = {
                tmst: rxpk.tmst + 1000000, // first receive window (1s)
                freq: rxpk.freq,
                rfch: 0, // only 0 can transmit
                modu: rxpk.modu,
                datr: rxpk.datr,
                codr: rxpk.codr,
                ipol: true,
                size: send_data.length,
                data: send_data.toString('base64')
            };

            let databuf = Buffer.concat([header, Buffer.from(JSON.stringify({txpk: txpk}))]);
            await downlink_out.writeAsync(databuf);

            let tx_ack = await wait_for(downlink_in, pkts.TX_ACK);
            if (tx_ack.compare(header, 1, 3, 1, 3) !== 0) {
                console.error('ERROR: tx token mismatch');
            }
        }
    }
})();
```

Other examples can be found in the [util](util) directory. It contains
Javascript versions of the Semtech `link:util/sink.js[sink]`,
`link:util/ack.js[ack]` and `link:util/tx_test.js[tx_test]` utilities.

# Installation

``` bash
npm install lora-comms
```

# IMST iC880A-SPI reset

If you’re using an IMST iC880A-SPI, it needs to be reset after it’s
powered up.

My iC880A-SPI is connected to a Pi via a
[backplane](https://shop.coredump.ch/product/ic880a-lorawan-gateway-backplane/)
which brings the reset line out on GPIO 25. I run the following shell
script to perform the reset:

**iC880A-SPI\_reset.sh.**

``` sh
#!/bin/sh
echo "25" > /sys/class/gpio/export
echo "out" > /sys/class/gpio/gpio25/direction
echo "1" > /sys/class/gpio/gpio25/value
sleep 5
echo "0" > /sys/class/gpio/gpio25/value
sleep 1
echo "0" > /sys/class/gpio/gpio25/value
chmod o+rw /dev/spidev0.0
```

# Test

You’ll need a LoRa device running
[test/node\_lora\_comms\_test.ino](test/node_lora_comms_test.ino)
(tested on a SODAQ Explorer). Then run:

``` bash
grunt test
```

# Lint

``` bash
grunt lint
```

# Coverage

You’ll need a LoRa device running
[test/node\_lora\_comms\_test.ino](test/node_lora_comms_test.ino)
(tested on a SODAQ Explorer). Then run:

``` bash
grunt coverage
```

[c8](https://github.com/bcoe/c8) results are available
[here](http://rawgit.davedoesdev.com/davedoesdev/node-lora-comms/master/coverage/lcov-report/index.html).

# Licence

[MIT](LICENCE)
