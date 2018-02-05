const path = require('path'),
      lora_comms = require('..');

lora_comms.start(
{
    cfg_dir: path.join(__dirname, '..', '..', 'packet_forwarder_shared', 'lora_pkt_fwd')
});

process.on('SIGINT', () => lora_comms.stop());

lora_comms.uplink.on('readable', function ()
{
    while (true)
    {
        let data = this.read();
        if (data === null)
        {
            break;
        }
        console.log(`Uplink got packet ${data.length} bytes long`);
    }
});

lora_comms.downlink.on('readable', function ()
{
    while (true)
    {
        let data = this.read();
        if (data === null)
        {
            break;
        }
        console.log(`Downlink got packet ${data.length} bytes long`);
    }
});
