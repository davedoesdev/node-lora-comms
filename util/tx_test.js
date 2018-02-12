const lora_comms = require('..'),
      path = require('path'),
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
              type: 'number',
              describe: 'target frequency in MHz',
              default: 866.0
          })
          .check(argv => (argv.f >= 30) && (argv.f <= 3000))
          .option('m', {
              choices: ['LORA', 'FSK'],
              describe: 'modulation type',
              default: 'LORA'
          })
          .option('s', {
              type: 'number',
              describe: 'spreading factor [7:12]',
              default: 10
          })
          .check(argv => (argv.s >= 7) && (argv.s <= 12))
          .option('b', {
              choices: [125, 250, 500],
              describe: 'modulation bandwidth in kHz',
              default: 125
          })
          .option('d', {
              type: 'number',
              describe: 'FSK frequency deviation in kHz [1:250]',
              default: 25
          })
          .check(argv => (argv.d >= 1) && (argv.d <= 250))
          .option('r', {
              type: 'number',
              describe: 'FSK bitrate in kbps [0.5:250]',
              default: 50
          })
          .check(argv => (argv.r >= 0.5) && (argv.r <= 250))
          .option('p', {
              type: 'number',
              describe: 'RF power (dBm)',
              default: 14
          })
          .check(argv => (argv.p >= 0) && (argv.p <= 30))
          .option('z', {
              type: 'number',
              describe: 'payload size in bytes [9:255]',
              default: 9
          })
          .check(argv => (argv.z >= 9) && (argv.z <= 255))
          .option('t', {
              type: 'number',
              describe: 'pause between packets (ms)',
              default: 1000
          })
          .check(argv => (argv.t >= 0))
          .option('x', {
              type: 'number',
              describe: 'number of times the sequence is repeated',
              default: 1
          })
          .check(argv => (argv.x >= 1))
          .option('v', {
              type: 'number',
              describe: 'test ID, inserted in payload for PER test [0:255]',
              default: 0
          })
          .check(argv => (argv.v >= 0) && (argv.v <= 255))
          .option('i', {
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
          PULL_ACK: 4
      };

process.on('SIGINT', lora_comms.stop);
lora_comms.on('stop', () => console.log('stopped'));

lora_comms.start_logging();
lora_comms.log_info.pipe(process.stdout);
lora_comms.log_error.pipe(process.stderr);

lora_comms.on('error', console.error);

// prevent uplink packets being queued
// problem: on first write, hwm will be 0 so will be written
lora_comms.LoRaComms.set_gw_send_hwm(lora_comms.uplink, 0);
lora_comms.LoRaComms.set_gw_send_timeout();

lora_comms.start(argv);


// send packets
