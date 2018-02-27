const lora_comms = require('..'),
      path = require('path'),
      { Transform } = require('stream');
      argv = require('yargs').command(
          '$0',
          'Network sink, receives packets and discards them')
          .option('c', {
              alias: 'cfg_dir',
              type: 'string',
              describe: 'configuration directory',
              default: path.join(__dirname, '..',
                                 'packet_forwarder_shared', 'lora_pkt_fwd')
          })
          .argv;

process.on('SIGINT', lora_comms.stop);
lora_comms.on('stop', () => console.log('stopped'));

lora_comms.start_logging();
lora_comms.log_info.pipe(process.stdout);
lora_comms.log_error.pipe(process.stderr);

lora_comms.on('error', console.error);

lora_comms.start(argv);

function sink(link)
{
    lora_comms[link].pipe(new Transform(
    {
        transform(data, _, cb)
        {
            this.push(`${link} got packet ${data.length} bytes long\n`);
            cb();
        }
    })).pipe(process.stdout);
}

sink('uplink');
sink('downlink');
