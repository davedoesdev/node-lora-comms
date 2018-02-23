// Tested with a SODAQ ExpLoRer running ./echo.ino

const lora_comms = require('..'),
      path = require('path'),
      PROTOCOL_VERSION = 2,
      pkts = {
          PUSH_DATA: 0,
          PUSH_ACK: 1,
          PULL_DATA: 2,
          PULL_RESP: 3,
          PULL_ACK: 4,
          TX_ACK: 5
      };

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
});

after(function (cb)
{
    this.timeout(30 * 1000);

    if (!lora_comms.active)
    {
        return cb();
    }

    lora_comms.once('stop', cb);
    lora_comms.stop();
});

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
    it('should receive same data sent', function (done)
    {
        this.timeout(30000);

        let sent_payload = Buffer.alloc(12);

        lora_comms.uplink.pipe(new Transform(
        {
            transform(data, _, cb)
            {
                if ((data.length < 12) ||
                    (data[0] !== PROTOCOL_VERSION) ||
                    (data[3] !== pkts['PUSH_DATA']))
                {
                    return cb();
                }

                data[3] = pkts['PUSH_ACK'];
                cb(null, data.slice(0, 4));

                // Decode payload
                // Check if matches - unpipe and done if so
                // unpipe other pipe too

                // Save it so other pipe can send it
                // Perhaps we should make the TX_RESP here and write it
                // It can save it and send it when it gets PULL_DATA or TX_ACK
            }
        })).pipe(lora_comms.uplink);

/*
        // wait for PUSH_DATA

        // send PUSH_ACK

        // wait for PULL_DATA
        let data = await wait_for(downlink, pkts.PULL_DATA);

        // send PULL_ACK
        data[3] = pkts.PULL_ACK;
        downlink.writeAsync(data);

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
