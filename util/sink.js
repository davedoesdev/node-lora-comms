const path = require('path'),
      lora_comms = require('..');

// TODO:
// log function (default no display on stdout/stderr)

process.on('SIGINT', () => lora_comms.stop());
lora_comms.on('stop', () => console.log('stopped'));

lora_comms.start(
{
    cfg_dir: path.join(__dirname, '..', '..', 'packet_forwarder_shared', 'lora_pkt_fwd')
});

function sink(link)
{
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
