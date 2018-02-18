const lora_comms = require('..'),
      path = require('path');

// Tested with a SODAQ ExpLoRer running ./echo.ino 

beforeEach(function ()
{
    lora_comms.start_logging();
    lora_comms.log_info.pipe(process.stdout);
    lora_comms.log_error.pipe(process.stderr);

    lora_comms.start(
    {
        cfg_dir: path.join(__dirname, '..', '..',
                           'packet_forwarder_shared', 'lora_pkt_fwd')
    });
});

afterEach(function (cb)
{
    let count = 0;
    function check()
    {
        count++;
        if (count === 3)
        {
            lora_comms.stop_logging();
            cb();
        }
    }

    lora_comms.once('stop', ended);
    lora_comms.log_info.on('end', ended);
    lora_comms.log_error.on('end', ended);

    lora_comms.stop();
});

describe('echoing device', function ()
{
    it('should receive same data sent', function (cb)
    {
        setTimeout(cb, 1000);

    });
});

// test logging
