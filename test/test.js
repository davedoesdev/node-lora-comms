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
      },
      // USE YOUR OWN KEYS!
      DevAddr = Buffer.alloc(4),
      NwkSKey = Buffer.alloc(16),
      AppSKey = Buffer.alloc(16),
      payload_size = 12;

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

function start(options)
{
    options = Object.assign(
    {
        cfg_dir: path.join(__dirname, '..',
                           'packet_forwarder_shared', 'lora_pkt_fwd')
    }, options);
    
    return function ()
    {
        lora_comms.start_logging();
        lora_comms.log_info.pipe(process.stdout);
        lora_comms.log_error.pipe(process.stderr);

        lora_comms.start(options);

        if (!options.no_streams)
        {
            uplink = aw.createDuplexer(lora_comms.uplink);
            downlink = aw.createDuplexer(lora_comms.downlink);
        }
    };
}

function stop(cb)
{
    if (this && this.timeout)
    {
        this.timeout(30 * 1000);
    }

    if (!lora_comms.active)
    {
        return cb();
    }

    lora_comms.once('stop', cb);
    lora_comms.stop();
}
process.on('SIGINT', () => stop(() => {}));

function wait_for_logs(cb)
{
    if (!lora_comms.logging_active)
    {
        return cb();
    }

    lora_comms.once('logging_stop', cb);
    // no need to call lora_comms.stop_logging(), logging_stop will be emitted
    // once the log streams end
}

describe('echoing device', function ()
{
    before(start());
    after(stop);
    after(wait_for_logs);

    it('should receive same data sent', async function ()
    {
        this.timeout(60 * 60 * 1000);

        await wait_for(downlink, pkts.PULL_DATA);

        let send_payload = crypto.randomBytes(payload_size);
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

            if (!buffers.DevAddr.equals(DevAddr))
            {
                continue;
            }

            expect(lora_packet.verifyMIC(decoded, NwkSKey)).to.be.true;

            let recv_payload = lora_packet.decrypt(decoded, AppSKey, NwkSKey);

            if (recv_payload.length !== payload_size)
            {
                continue;
            }

            if (recv_payload.equals(send_payload))
            {
                // Shouldn't happen because send on reverse polarity
                console.error('Received packet we sent');
                continue;
            }

            if (recv_payload.compare(send_payload,
                                     payload_size/2,
                                     payload_size,
                                     payload_size/2,
                                     payload_size) === 0)
            {
                break;
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
                //powe: 14,
                modu: rxpk.modu,
                datr: rxpk.datr,
                codr: rxpk.codr,
                ipol: true,
                //prea: 8,
                size: send_data.length,
                data: send_data.toString('base64')
            };

            let databuf = Buffer.concat([header, Buffer.from(JSON.stringify({txpk: txpk}))]);
            await downlink.writeAsync(databuf);

            let tx_ack = await wait_for(downlink, pkts.TX_ACK);
            expect(tx_ack[1]).to.equal(header[1]);
            expect(tx_ack[2]).to.equal(header[2]);
        }
    });
});

describe('errors', function ()
{
    it("should error if can't find configuration file", function (cb)
    {
        lora_comms.once('error', function (err)
        {
            expect(err.message).to.equal('failed');
            cb();
        });

        start({cfg_dir: 'foobar'})();
    });
});

describe('logging', function ()
{
    it('should be able to end log streams', function (cb)
    {
        this.timeout(30 * 1000);
        lora_comms.once('logging_stop', function ()
        {
            lora_comms.once('stop', cb);
            lora_comms.stop();
        });
        start()();
        expect(lora_comms.uplink).not.to.be.undefined;
        expect(lora_comms.downlink).not.to.be.undefined;
        lora_comms.stop_logging();
    });
});

describe('start multiple times', function ()
{
    it('should be able to start twice', function (cb)
    {
        this.timeout(30 * 1000);
        start()();
        lora_comms.start();
        lora_comms.once('stop', cb);
        lora_comms.stop();
    });

    it('should be able to start logging twice', function (cb)
    {
        this.timeout(30 * 1000);
        start()();
        lora_comms.start_logging();
        lora_comms.once('stop', cb);
        lora_comms.stop();
    });
});

describe('no streams', function ()
{
    it('should be able to disable stream creation', function (cb)
    {
        this.timeout(30 * 1000);
        start({ no_streams: true })();
        expect(lora_comms.uplink).to.be.null;
        expect(lora_comms.downlink).to.be.null;
        lora_comms.once('stop', cb);
        lora_comms.stop();
    });
});
