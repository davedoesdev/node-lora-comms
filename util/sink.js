const lora_comms = require('..'),
      path = require('path'),
      { Transform } = require('stream');

process.on('SIGINT', lora_comms.stop);
lora_comms.on('stop', () => console.log('stopped'));

lora_comms.start_logging();
lora_comms.log_info.pipe(process.stdout);
lora_comms.log_error.pipe(process.stderr);

lora_comms.on('error', console.error);

lora_comms.start(
{
    cfg_dir: path.join(__dirname, '..', '..', 'packet_forwarder_shared', 'lora_pkt_fwd')
});

function sink(link)
{
    lora_comms[link].pipe(new Transform(
    {
        transform(data, encoding, callback)
        {
            this.push(`${link} got packet ${data.length} bytes long\n`);
        }
    })).pipe(process.stdout);
}

sink('uplink');
sink('downlink');
