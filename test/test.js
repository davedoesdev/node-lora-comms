// Tested with a SODAQ ExpLoRer running ./node-lora-comms-test.ino

const lora_comms = require('..'),
      lora_packet = require('lora-packet'),
      path = require('path'),
      crypto = require('crypto'),
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
    while (true)
    {
        let data = await link.readAsync();
        if ((data.length >= 4) && (data[0] === PROTOCOL_VERSION))
        {
            let type = data[3];

            if (type === pkts.PUSH_DATA)
            {
                data[3] = pkts.PUSH_ACK;
                await uplink.writeAsync(data.slice(0, 4));
            }

            if (type === pkts.PULL_DATA)
            {
                data[3] = pkts.PULL_ACK;
                await downlink.writeAsync(data.slice(0, 4));
            }

            if (type === pkt)
            {
                return data;
            }
        }

    }
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

        await wait_for(downlink, pkts.PULL_DATA);

        let send_payload = crypto.randomBytes(12);
        let count = 0;

        while (true)
        {
            let packet = await wait_for(uplink, pkts.PUSH_DATA);
            let payload = JSON.parse(packet.slice(12));
            if (!payload.rxpk || !payload.rxpk[0])
            {
                continue;
            }
            let rxpk = payload.rxpk[0];

            let recv_data = Buffer.from(rxpk.data, 'base64');
            let decoded = lora_packet.fromWire(recv_data);
            let buffers = decoded.getBuffers();

            let DevAddr = Buffer.alloc(4); // TODO: Use non-zero keys
            if (!buffers.DevAddr.equals(DevAddr))
            {
                continue;
            }

            let NwkSKey = Buffer.alloc(16); // TODO: Use non-zero keys
            expect(lora_packet.verifyMIC(decoded, NwkSKey)).to.be.true;

            let AppSKey = Buffer.alloc(16); // TODO: Use non-zero keys
            let recv_payload = lora_packet.decrypt(decoded, AppSKey, NwkSKey);

            if (recv_payload.compare(send_payload, 6, send_payload.length, 6) === 0)
            {
                break;
            }

            send_payload = Buffer.concat([recv_payload.slice(0, 6),
                                          crypto.randomBytes(6)]);

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
                imme: true,
                freq: rxpk.freq,
                rfch: 0, // only 0 can transmit
                powe: 14,
                modu: rxpk.modu,
                datr: rxpk.datr,
                codr: rxpk.codr,
                ipol: false,
                prea: 8,
                size: send_data.length,
                data: send_data.toString('base64')
            };

            let databuf = Buffer.concat([header, Buffer.from(JSON.stringify({txpk: txpk}))]);
            await downlink.writeAsync(databuf);

            let tx_ack = await wait_for(downlink, pkts.TX_ACK);
            expect(tx_ack[1]).to.equal(header[1]);
            expect(tx_ack[2]).to.equal(header[2]);

/*
{ rxpk: 
   [ { tmst: 54497595,
       chan: 1,
       rfch: 1,
       freq: 868.3,
       stat: 1,
       modu: 'LORA',
       datr: 'SF7BW125',
       codr: '4/5',
       lsnr: 10.2,
       rssi: -5,
       size: 25,
       data: 'QAAAAAAAPgABEUCVTKXXJqtyU18zz04VpQ==' } ] }
*/



            // make packet for forwarder


            // send
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
