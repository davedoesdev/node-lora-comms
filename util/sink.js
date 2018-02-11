const lora_comms = require('..'),
      path = require('path');

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
// TODO: should we do this using pipe through to transform stream
// which is then piped through to process.stdout?

    lora_comms[link].on('readable', function ()
    {
        while (true)
        {
            let data = this.read();
            if (data === null)
            {
                break;
            }
            console.log(`${link} got packet ${data.length} bytes long`);
        }
    });
}

sink('uplink');
sink('downlink');
