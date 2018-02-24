// Tested with a SODAQ ExpLoRer running ./node-lora-comms-test.ino

const lora_comms = require('..'),
      lora_packet = require('lora-packet'),
      path = require('path'),
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
      };

let uplink, downlink;

async function wait_for(link, pkt)
{
    let data;
    do
    {
        data = await link.readAsync();
    }
    while ((data.length < 4) ||
           (data[0] !== PROTOCOL_VERSION) ||
           (data[3] !== pkt));
    return data;
}

before(function ()
{
    lora_comms.start_logging();
    lora_comms.log_info.pipe(process.stdout);
    lora_comms.log_error.pipe(process.stderr);

    lora_comms.start(
    {
        cfg_dir: path.join(__dirname, '..', '..',
                           'packet_forwarder_shared', 'lora_pkt_fwd')
    });

    uplink = aw.createDuplexer(lora_comms.uplink);
    downlink = aw.createDuplexer(lora_comms.downlink);
});

function stop(cb)
{
    if (!lora_comms.active)
    {
        return cb();
    }

    lora_comms.once('stop', cb);
    lora_comms.stop();
}
after(function (cb)
{
    this.timeout(30 * 1000);
    stop(cb);
});
process.on('SIGINT', () => stop(() => {}));

after(function (cb)
{
    if (!lora_comms.logging_active)
    {
        return cb();
    }

    lora_comms.once('logging_stop', cb);
    // no need to call lora_comms.stop_logging(), logging_stop will be emitted
    // once the log streams end
});

describe('echoing device', function ()
{
    it('should receive same data sent', async function ()
    {
        this.timeout(60 * 60 * 1000);

        while (true)
        {
            let packet = await wait_for(downlink, pkts.PULL_DATA);
            packet[3] = pkts.PULL_ACK;
            await downlink.writeAsync(packet.slice(0, 4));

            packet = await wait_for(uplink, pkts.PUSH_DATA);
            packet[3] = pkts.PUSH_ACK;
            await uplink.writeAsync(packet.slice(0, 4));

            let payload = JSON.parse(packet.slice(12));
            if (!payload.rxpk)
            {
                continue;
            }

            let data = Buffer.from(payload.rxpk[0].data, 'base64');
            let decoded = lora_packet.fromWire(data);
            let buffers = decoded.getBuffers();

            if (!buffers.DevAddr.equals(Buffer.alloc(4)))
            {
                continue;
            }

            let NwkSKey = Buffer.alloc(16); // TODO: Use non-zero keys
            expect(lora_packet.verifyMIC(decoded, NwkSKey)).to.be.true;

            let AppSKey = Buffer.alloc(16);
            console.log(lora_packet.decrypt(decoded, AppSKey, NwkSKey));

            break;
        }


/*

                // Decode payload
                // Check if matches - unpipe and done if so
                // unpipe other pipe too

                // Save it so other pipe can send it
                // Perhaps we should make the TX_RESP here and write it
                // It can save it and send it when it gets PULL_DATA or TX_ACK
            }
        })).pipe(lora_comms.uplink);

        // send TX_RESP with value from device and random value from us

                // TODO: check TX_ACK token
        // wait for TX_ACK and PUSH_DATA
        // send PUSH_ACK
        // check value is echoed back to us

        // how do we ensure we can run this at any time?
        // device will have to set timeout after which it tries to send again

        // loop (note prevent waiting for PUSH_DATA twice above)
        // - have waiting for (starts null)
*/


    });
});

// test logging
