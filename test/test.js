"use strict";

// Tested with a SODAQ ExpLoRer running ./node_lora_comms_test.ino

const lora_comms = require('..'),
      LoRaComms = require('bindings')('lora_comms').LoRaComms,
      lora_packet = require('lora-packet'),
      crypto = require('crypto'),
      { EventEmitter } = require('events'),
      { Transform, PassThrough } = require('stream'),
      aw = require('awaitify-stream'),
      expect = require('chai').expect,
      argv = require('yargs').argv,
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

async function wait_for(link, pkt)
{
    while (true)
    {
        let data = await link.readAsync();
        if ((data.length >= 4) &&
            (data[0] === PROTOCOL_VERSION) &&
            (data[3] === pkt))
        {
            return data;
        }
    }
}

let uplink_out, downlink_out, downlink_in;

function ack(data, _, cb)
{
    (async () =>
    {
        if ((data.length >= 4) && (data[0] === PROTOCOL_VERSION))
        {
            let type = data[3];

            if (type === pkts.PUSH_DATA)
            {
                await uplink_out.writeAsync(Buffer.concat([
                    data.slice(0, 3),
                    Buffer.from([pkts.PUSH_ACK])]));
            }
            else if (type === pkts.PULL_DATA)
            {
                await downlink_out.writeAsync(Buffer.concat([
                    data.slice(0, 3),
                    Buffer.from([pkts.PULL_ACK])]));
            }
        }

        cb(null, data);
    })();
}

async function start_simulate(options) {
    if (!lora_comms.uplink) {
        return;
    }

    const up = aw.createDuplexer(
        new lora_comms.uplink.constructor(-1 - lora_comms.uplink._link));

    const down = aw.createDuplexer(
        new lora_comms.downlink.constructor(-1 - lora_comms.downlink._link));

    const pull_data = Buffer.alloc(12);
    pull_data[0] = PROTOCOL_VERSION;
    crypto.randomFillSync(pull_data, 1, 2);
    pull_data[3] = pkts.PULL_DATA;
    await down.writeAsync(pull_data);

    const pull_ack = await down.readAsync();
    if (!pull_ack) { return; }
    expect(pull_ack.length).to.equal(4);
    expect(pull_ack[0]).to.equal(PROTOCOL_VERSION);
    expect(pull_ack[1]).to.equal(pull_data[1]);
    expect(pull_ack[2]).to.equal(pull_data[2]);
    expect(pull_ack[3]).to.equal(pkts.PULL_ACK);

    let fcnt_up = 0;
    let fcnt_down = 0;
    let recv_payload = Buffer.alloc(payload_size);

    while (true) {
        const send_payload = Buffer.concat([
            crypto.randomBytes(payload_size / 2),
            recv_payload.slice(payload_size / 2)
        ]);

        const push_data = Buffer.alloc(12);
        push_data[0] = PROTOCOL_VERSION;
        crypto.randomFillSync(push_data, 1, 2);
        push_data[3] = pkts.PUSH_DATA;
        await up.writeAsync(Buffer.concat([
            push_data,
            Buffer.from(JSON.stringify({
                rxpk: [{
                    data: lora_packet.fromFields({
                        MType: 'Unconfirmed Data Up',
                        DevAddr,
                        payload: send_payload,
                        FCnt: fcnt_up
                    }, AppSKey, NwkSKey).getPHYPayload().toString('base64')
                }]
            }))
        ]));

        const push_ack = await up.readAsync();
        if (!push_ack) { break; }
        expect(push_ack.length).to.equal(4);
        expect(push_ack[0]).to.equal(PROTOCOL_VERSION);
        expect(push_ack[1]).to.equal(push_data[1]);
        expect(push_ack[2]).to.equal(push_data[2]);
        expect(push_ack[3]).to.equal(pkts.PUSH_ACK);

        const pull_resp = await down.readAsync();
        if (!pull_resp) { break; }
        expect(pull_resp.length).to.be.at.least(4);
        expect(pull_resp[0]).to.equal(PROTOCOL_VERSION);
        expect(pull_resp[3]).to.equal(pkts.PULL_RESP);

        const decoded = lora_packet.fromWire(Buffer.from(
                JSON.parse(pull_resp.slice(4)).txpk.data, 'base64'));
        expect(decoded.getMType()).to.equal('Unconfirmed Data Down');

        const tx_ack = Buffer.alloc(12);
        tx_ack[0] = PROTOCOL_VERSION;
        tx_ack[1] = pull_resp[1];
        tx_ack[2] = pull_resp[2];
        tx_ack[3] = pkts.TX_ACK;
        await down.writeAsync(tx_ack);

        const buffers = decoded.getBuffers();
        expect(buffers.DevAddr.equals(DevAddr)).to.equal(true);
        expect(lora_packet.verifyMIC(decoded, NwkSKey)).to.be.true;
        const fcnt = Buffer.alloc(2);
        fcnt.writeUint16BE(fcnt_down++, 0);
        expect(buffers.FCnt.equals(fcnt)).to.be.true;

        recv_payload = lora_packet.decrypt(decoded, AppSKey, NwkSKey);
        expect(recv_payload.length).to.equal(payload_size);
        expect(recv_payload.compare(send_payload,
                                    0,
                                    payload_size / 2,
                                    0,
                                    payload_size / 2)).to.equal(0);
    }
}

let simulatorP, simulatorErr;

function start(options)
{
    lora_comms.start_logging(options);

    if (options && options.highWaterMark)
    {
        lora_comms.log_info.on('readable', function ()
        {
            process.nextTick(() =>
            {
                let data;
                while ((data = this.read()) !== null)
                {
                    process.stdout.write(data.toString());
                }
            });
        });

        lora_comms.log_error.on('readable', function ()
        {
            process.nextTick(() =>
            {
                let data;
                while ((data = this.read()) !== null)
                {
                    process.stderr.write(data.toString());
                }
            });
        });
    }
    else
    {
        lora_comms.log_info.pipe(process.stdout);
        lora_comms.log_error.pipe(process.stderr);
    }

    lora_comms.start(options);

    if (!(options && options.no_streams))
    {
        uplink_out = aw.createWriter(lora_comms.uplink);
        downlink_out = aw.createWriter(lora_comms.downlink);
    }

    simulatorP = null;
    simulatorErr = null;

    if (argv.simulate) {
        simulatorP = start_simulate(options).catch(err => {
            simulatorErr = err;
        });
    }
}

function stop(cb)
{
    if (!lora_comms.active)
    {
        return cb();
    }

    lora_comms.once('stop', async () => {
        if (simulatorP) {
            await simulatorP;
        }
        if ((this.currentTest.title === 'should error when data is too big') &&
            (simulatorErr.message === `expected ${lora_comms.LoRaComms.send_to_buflen} to equal 4`)) {
            return cb();
        }
        if (simulatorErr && (simulatorErr.errno === LoRaComms.EBADF)) {
            return cb();
        }
        cb(simulatorErr);
    });
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

afterEach(stop);
afterEach(wait_for_logs);

describe('echoing device', function ()
{
    this.timeout(60 * 60 * 1000);

    async function echo(options)
    {
        start(options);

        const link_options = Object.assign(
        {
            transform: ack,
            highWaterMark: 0
        }, options);
        let uplink_in = aw.createReader(lora_comms.uplink.pipe(
            new Transform(link_options)));
        downlink_in = aw.createReader(lora_comms.downlink.pipe(
            new Transform(link_options)));

        await wait_for(downlink_in, pkts.PULL_DATA);

        let send_payload = crypto.randomBytes(payload_size);
        let count = 0;

        while (true)
        {
            let packet = await wait_for(uplink_in, pkts.PUSH_DATA);
            let payload = JSON.parse(packet.slice(12));
            if (!payload.rxpk)
            {
                continue;
            }
            for (let rxpk of payload.rxpk)
            {
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
                    return;
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
                await downlink_out.writeAsync(databuf);

                let tx_ack = await wait_for(downlink_in, pkts.TX_ACK);
                expect(tx_ack[1]).to.equal(header[1]);
                expect(tx_ack[2]).to.equal(header[2]);
            }
        }
    }

    it('should receive same data sent', async function()
    {
        await echo();
    });

    describe('high-water mark 1', function ()
    {
        it('should receive same data sent', async function()
        {
            await echo({ highWaterMark: 1 });
        });
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

        start({cfg_dir: 'foobar'});
    });

    it('should propagate read errors', function (cb)
    {
        start();
        lora_comms.uplink.once('error', function (err)
        {
            expect(err.errno).to.equal(lora_comms.LoRaComms.EINVAL);
            cb();
        });
        lora_comms.uplink._link = 999;
        lora_comms.uplink.read();
    });

    it('should propagate write errors', function (cb)
    {
        start();
        lora_comms.uplink.once('error', function (err)
        {
            expect(err.errno).to.equal(lora_comms.LoRaComms.EINVAL);
            cb();
        });
        lora_comms.uplink._link = 999;
        lora_comms.uplink.write('foobar');
    });

    it('should propagate logging errors', function (cb)
    {
        start();
        let orig_get_log_message = lora_comms.log_info._get_log_message;
        lora_comms.log_info.once('error', function (err)
        {
            expect(err.message).to.equal('dummy');
            lora_comms.log_info._get_log_message = orig_get_log_message;
            lora_comms.log_info._read();
            cb();
        });
        lora_comms.log_info._get_log_message = function (buf, s, us, cb)
        {
            cb(new Error('dummy'));
        };
    });

    it('should error when data is too big', function (cb)
    {
        start();
        lora_comms.downlink.once('error', function (err)
        {
            expect(err.message).to.equal('not all data was written');
            cb();
        });
        lora_comms.downlink.write(Buffer.alloc(lora_comms.LoRaComms.send_to_buflen + 1));
    });

    it('should error if write after stopped', function (cb)
    {
        start();
        lora_comms.once('stop', function ()
        {
            lora_comms.downlink._write(Buffer.from('foo'), null, function (err)
            {
                expect(err.errno).to.equal(lora_comms.LoRaComms.EBADF);
                cb();
            });
        });
        lora_comms.stop();
    });
});

describe('logging', function ()
{
    it('should be able to end log streams', function (cb)
    {
        start();
        lora_comms.once('logging_stop', cb);
        expect(lora_comms.uplink).not.to.be.undefined;
        expect(lora_comms.downlink).not.to.be.undefined;
        lora_comms.stop_logging();
    });
});

describe('multiple calls', function ()
{
    it('should be able to start twice', function (cb)
    {
        start();
        lora_comms.start();
        lora_comms.once('stop', cb);
        lora_comms.stop();
    });

    it('should be able to start logging twice', function (cb)
    {
        start();
        lora_comms.start_logging();
        lora_comms.once('stop', cb);
        lora_comms.stop();
    });
});

describe('no streams', function ()
{
    it('should be able to disable stream creation', function (cb)
    {
        start({ no_streams: true });
        expect(lora_comms.uplink).to.be.null;
        expect(lora_comms.downlink).to.be.null;
        lora_comms.once('stop', cb);
        lora_comms.stop();
    });
});

describe('timeout', function ()
{
    it('should check for messages', function (cb)
    {
        start({ no_streams: true });
        let buf = Buffer.alloc(lora_comms.LoRaComms.recv_from_buflen);
        lora_comms.LoRaComms.recv_from(lora_comms.LoRaComms.uplink, buf, 0, 0, (err, r) =>
        {
            expect(err.errno).to.equal(lora_comms.LoRaComms.EAGAIN);
            expect(r).to.equal(-1);
            cb();
        });
    });

    it('should timeout reading messages', function (cb)
    {
        start({ no_streams: true });
        let buf = Buffer.alloc(lora_comms.LoRaComms.recv_from_buflen);
        lora_comms.LoRaComms.recv_from(lora_comms.LoRaComms.uplink, buf, 0, 1, (err, r) =>
        {
            expect(err.errno).to.equal(lora_comms.LoRaComms.EAGAIN);
            expect(r).to.equal(-1);
            cb();
        });
    });

    it('should check log for messages', function (cb)
    {
        start({ no_streams: true });
        let buf = Buffer.alloc(lora_comms.LoRaComms.get_log_max_msg_size());
        lora_comms.LoRaComms.get_log_error_message(buf, 0, 0, (err, r) =>
        {
            expect(err.errno).to.equal(lora_comms.LoRaComms.EAGAIN);
            expect(r).to.equal(-1);
            cb();
        });
    });

    it('should timeout reading log messages', function (cb)
    {
        start({ no_streams: true });
        let buf = Buffer.alloc(lora_comms.LoRaComms.get_log_max_msg_size());
        lora_comms.LoRaComms.get_log_error_message(buf, 0, 1, (err, r) =>
        {
            expect(err.errno).to.equal(lora_comms.LoRaComms.EAGAIN);
            expect(r).to.equal(-1);
            cb();
        });
    });
});
