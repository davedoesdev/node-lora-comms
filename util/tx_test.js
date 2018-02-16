const lora_comms = require('..'),
      path = require('path'),
      crypto = require('crypto'),
      { Transform } = require('stream'),
      argv = require('yargs').command(
          '$0',
          'Ask a gateway to emit packets using GW <-> server protocol')
          .option('c', {
              alias: 'cfg_dir',
              type: 'string',
              describe: 'configuration directory',
              default: path.join(__dirname, '..', '..',
                                 'packet_forwarder_shared', 'lora_pkt_fwd')
          })
          .option('f', {
              alias: 'f_target',
              type: 'number',
              describe: 'target frequency in MHz',
              default: 866.0
          })
          .check(argv => (argv.f >= 30) && (argv.f <= 3000))
          .option('m', {
              alias: 'mod',
              choices: ['LORA', 'FSK'],
              describe: 'modulation type',
              default: 'LORA'
          })
          .option('s', {
              alias: 'sf',
              type: 'number',
              describe: 'spreading factor [7:12]',
              default: 10
          })
          .check(argv => (argv.s >= 7) && (argv.s <= 12))
          .option('b', {
              alias: 'bw',
              choices: [125, 250, 500],
              describe: 'modulation bandwidth in kHz',
              default: 125
          })
          .option('d', {
              alias: 'fdev_khz',
              type: 'number',
              describe: 'FSK frequency deviation in kHz [1:250]',
              default: 25
          })
          .check(argv => (argv.d >= 1) && (argv.d <= 250))
          .option('r', {
              alias: 'br_kbps',
              type: 'number',
              describe: 'FSK bitrate in kbps [0.5:250]',
              default: 50
          })
          .check(argv => (argv.r >= 0.5) && (argv.r <= 250))
          .option('p', {
              alias: 'pow',
              type: 'number',
              describe: 'RF power (dBm)',
              default: 14
          })
          .check(argv => (argv.p >= 0) && (argv.p <= 30))
          .option('z', {
              alias: 'payload_size',
              type: 'number',
              describe: 'payload size in bytes [9:255]',
              default: 9
          })
          .check(argv => (argv.z >= 9) && (argv.z <= 255))
          .option('t', {
              alias: 'delay',
              type: 'number',
              describe: 'pause between packets (ms)',
              default: 1000
          })
          .check(argv => (argv.t >= 0))
          .option('x', {
              alias: 'repeat',
              type: 'number',
              describe: 'number of times the sequence is repeated',
              default: 1
          })
          .check(argv => (argv.x >= 1))
          .option('v', {
              alias: 'id',
              type: 'number',
              describe: 'test ID, inserted in payload for PER test [0:255]',
              default: 0
          })
          .check(argv => (argv.v >= 0) && (argv.v <= 255))
          .option('i', {
              alias: 'invert',
              type: 'boolean',
              describe: 'send packet using inverted modulation polarity',
              default: false
          })
          .argv,
      PROTOCOL_VERSION = 2,
      pkts = {
          PUSH_DATA: 0,
          PUSH_ACK: 1,
          PULL_DATA: 2,
          PULL_RESP: 3,
          PULL_ACK: 4,
          TX_ACK: 5
      };

if (argv.mod === 'FSK')
{
    console.info(`INFO: ${argv.repeat} FSK pkts @${argv.f_target} MHz (FDev ${argv.fdev_khz} kHz, Bitrate ${argv.br_kbps} kbps, ${argv.payload_size} payload) ${argv.pow} dBm, ${argv.delay} ms between each`);
}
else
{
    console.info(`INFO: ${argv.repeat} LoRa pkts @${argv.f_target} MHz (BW ${argv.bw}, SF${argv.sf}, ${argv.payload_size} payload) ${argv.pow} dBm, ${argv.delay} ms between each`);
}

process.on('SIGINT', lora_comms.stop);
lora_comms.on('stop', () => console.log('stopped'));

lora_comms.start_logging();
lora_comms.log_info.pipe(process.stdout);
lora_comms.log_error.pipe(process.stderr);

lora_comms.on('error', console.error);

// prevent uplink packets being queued
lora_comms.LoRaComms.set_gw_send_hwm(lora_comms.LoRaComms.uplink, 0);

// PKT_PULL_RESP datagram's header
let header = Buffer.alloc(4);
header[0] = PROTOCOL_VERSION;
header[1] = 0; // no token
header[2] = 0; // no token
header[3] = pkts.PULL_RESP;

// start of JSON structure
let txpk = {
    imme: true,
    freq: argv.f_target, // TX frequency
    rfch: 0,             // RF channel
    powe: argv.pow       // TX power
};

// modulation type and parameters
if (argv.mod === 'FSK')
{
    txpk.modu = 'FSK';
    txpk.datr = argv.br_kbps * 1e3;
    txpk.fdev = argv.fdev_khz * 1e3;
}
else
{
    txpk.modu = 'LORA';
    txpk.datr = `SF${argv.sf}BW${argv.bw}`;
    txpk.codr = "4/6";
}

txpk.ipol = argv.invert;       // signal polarity
txpk.prea = 8;                 // preamble size
txpk.size = argv.payload_size; // payload size

let i = 0;
let databuf;

function send(cb)
{
    // fill payload
    let payload_bin = Buffer.alloc(argv.payload_size);
    payload_bin[0] = argv.id;
    payload_bin.writeUInt32BE(i, 1);
    payload_bin.write('PER', 5);
    payload_bin[8] = 0;
    for (let j = 0; j < 8; j++)
    {
        payload_bin[8] = (payload_bin[8] + payload_bin[j]) % 256;
    }
    for (let j = 0; j < argv.payload_size - 9; j++)
    {
        payload_bin[9 + j] = j;
    }

    // encode the payload in Base64
    txpk.data = payload_bin.toString('base64');

    crypto.randomFillSync(header, 1, 2); // random token

    // send packet to the gateway
    databuf = Buffer.concat(header, Buffer.from(JSON.stringify({txpk: txpk})));
    if (databuf.length > lora_comms.LoRaComms.send_to_buflen)
    {
        return cb(new Error('data too long'));
    }
    this.push(databuf);
    console.info(`packet ${i} sent successfully`);

    // wait to receive a TX_ACK request packet
    console.info('waiting to receive a TX_ACK request');
    i++;
    cb();
}

lora_comms.start(argv);

// wait to receive a PULL_DATA request packet
console.info('INFO: waiting to receive a PULL_DATA request');
lora_comms.downlink.pipe(new Transform(
{
    transform(data, _, cb)
    {
        let expected = (i === 0) ? 'PULL_DATA' : 'TX_ACK';

        if ((data.length < 12) ||
            (data[0] !== PROTOCOL_VERSION) ||
            (data[3] !== pkts[expected]))
        {
            console.info('INFO: packet received, not ${expected}');
            return cb();
        }

        // retrieve gateway MAC from the request
        const mac_h = data.readUInt32BE(4);
        const mac_l = data.readUInt32BE(8);
        const gw_mac = ('0000000' + mac_h.toString(16)).substr(-8) +
                       ('0000000' + mac_l.toString(16)).substr(-8);

        // display info about the sender
        console.info(`INFO: ${expected} received from gateway ${gateway}`);

        if (i === 0)
        {
            // Send PULL_ACK
            data[3] = pkts.PULL_ACK;
            this.push(data.slice(0, 4));
        }
        else if ((data[1] !== databuf[1]) || (data[2] !== databuf[2]))
        {
            return cb(new Error("TX_ACK received but token doesn't match"));
        }

        if (i === argv.repeat)
        {
            return cb();
        }

        if (i === 0)
        {
            return send.call(this, cb);
        }

        // wait inter-packet delay
        setTimeout(send.bind(this, cb), argv.delay * 1000);
    }
})).pipe(lora_comms.downlink);
