"use strict";

const lora_comms = require('..'),
      { Transform } = require('stream'),
      argv = require('yargs').command(
          '$0',
          'Network sink, receives packets and sends an acknowledgement')
          .option('c', {
              alias: 'cfg_dir',
              type: 'string',
              describe: 'configuration directory'
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

lora_comms.start(argv);

function ack(link, pkt)
{
    lora_comms[link].pipe(new Transform(
    {
        transform(data, _, cb)
        {
            process.stdout.write(` -> pkt in, ${link}, ${data.length} bytes`);

            // check and parse the payload
            if (data.length < 12) // not enough bytes for packet from gateway
            {
                process.stdout.write(' (too short for GW <-> MAC protocol)\n');
                return cb();
            }

            // don't touch the token in position 1-2, it will be sent back
            // "as is" for acknowledgement
            if (data[0] !== PROTOCOL_VERSION) // check protocol version number
            {
                process.stdout.write(`, invalid version ${data[0]}\n`);
                return cb();
            }

            if (data[3] !== pkts[pkt + '_DATA'])
            {
                process.stdout.write(`, unexpected command ${data[3]}\n`);
                return cb();
            }

            const mac_h = data.readUInt32BE(4);
            const mac_l = data.readUInt32BE(8);
            const gw_mac = ('0000000' + mac_h.toString(16)).substr(-8) +
                           ('0000000' + mac_l.toString(16)).substr(-8);

            process.stdout.write(`, ${pkt}_DATA from gateway ${gw_mac}\n`);

            // add some artificial latency
            setTimeout(() =>
            {
                process.stdout.write(`<-  pkt out, ${pkt}_ACK`);
                data[3] = pkts[pkt + '_ACK'];
                cb(null, data.slice(0, 4));
                process.stdout.write(', 4 bytes sent\n');
            }, 30); // 30ms
        }
    })).pipe(lora_comms[link]);
}

ack('uplink', 'PUSH');
ack('downlink', 'PULL');
