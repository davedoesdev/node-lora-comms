const lora_comms = require('.'),
      lora_packet = require('lora-packet'),
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

process.on('SIGINT', lora_comms.stop);

lora_comms.start_logging();
lora_comms.log_info.pipe(process.stdout);
lora_comms.log_error.pipe(process.stderr);

lora_comms.start();

const uplink = aw.createDuplexer(lora_comms.uplink);
const downlink = aw.createDuplexer(lora_comms.downlink);

async function wait_for(link, pkt) {
    while (true) {
        let data = await link.readAsync();
        if ((data.length >= 4) && (data[0] === PROTOCOL_VERSION)) {
            let type = data[3];

            if (type === pkts.PUSH_DATA) {
                data[3] = pkts.PUSH_ACK;
                await uplink.writeAsync(data.slice(0, 4));
            }

            if (type === pkts.PULL_DATA) {
                data[3] = pkts.PULL_ACK;
                await downlink.writeAsync(data.slice(0, 4));
            }

            if (type === pkt) {
                return data;
            }
        }
    }
}

(async () => {
    await wait_for(downlink, pkts.PULL_DATA);

    let send_payload = crypto.randomBytes(payload_size);
    let count = 0;

    while (true)
    {
        let packet = await wait_for(uplink, pkts.PUSH_DATA);
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
            await downlink.writeAsync(databuf);

            let tx_ack = await wait_for(downlink, pkts.TX_ACK);
            if (tx_ack.compare(header, 1, 3, 1, 3) !== 0) {
                console.log('SUCCESS: Received matching data');
            }
        }
    }
})();
