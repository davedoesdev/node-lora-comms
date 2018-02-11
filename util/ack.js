const lora_comms = require('..'),
      path = require('path'),
      PROTOCOL_VERSION = 2,
      PKT_PUSH_DATA = 0,
      PKT_PUSH_ACK = 1,
      PKT_PULL_DATA = 2,
      PKT_PULL_RESP = 3,
      PKT_PULL_ACK = 4;

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

function ack(link)
{
// TODO: can we do this with some pipes?
// pipe into 2 pipes
// which are transform streams which filter out ones don't want
// which then pipe into writing the ACKs

    // wait to receive a packet
    lora_comms[link].on('readable', function ()
    {
        while (true)
        {
            let data = this.read();
            if (data === null)
            {
                break;
            }

            console.log(` -> pkt in, ${link}, ${data.length} bytes`);

            // check and parse the payload
            if (data.length < 12) // not enough bytes for packet from gateway
            {
                console.error(' (too short for GW <-> MAC protocol)');
                continue;
            }

            // don't touch the token in position 1-2, it will be sent back
            // "as is" for acknowledgement
            if (data[0] != PROTOCOL_VERSION) // check protocol version number
            {
                console.error(`, invalid version ${data[0]}`);
                continue;
            }

            const mac_h = data.readUInt32BE(4);
            const mac_l = data.readUInt32BE(8);
            const gw_mac = ('0000000' + mac_h.toString(16)).substr(-8) +
                           ('0000000' + mac_l.toString(16)).substr(-8);

            let ack_command, ack_message;
            if ((link === 'uplink') && (data[3] === PKT_PUSH_DATA))
            {
                console.log(`, PUSH_DATA from gateway ${gw_mac}`);
                ack_command = PKT_PUSH_ACK;
                ack_message = '<-  pkt out, PUSH_ACK';
            }
            else if ((link === 'downlink') && (data[3] === PKT_PULL_DATA))
            {
                console.log(`, PULL_DATA from gateway ${gw_mac}`);
                ack_command = PKT_PULL_ACK;
                ack_message = '<-  pkt out, PULL_ACK';
            }
            else
            {
                console.error(`, unexpected command ${data[3]}`);
                continue;
            }

            // add some artificial latency
            setTimeout(() =>
            {
                console.log(ack_message);
                data[3] = ack_command;
                lora_comms[link].write(data.slice(0, 4));
                console.log(', 4 bytes sent');
            }, 30); // 30ms
        }
    });
}

ack('uplink');
ack('downlink');
