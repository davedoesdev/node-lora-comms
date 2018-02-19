// Tested with a SODAQ ExpLoRer running ./echo.ino

const lora_comms = require('..'),
      path = require('path');

before(function ()
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

after(function (cb)
{
    this.timeout(30 * 1000);

    if (!lora_comms.active)
    {
        return cb();
    }

    lora_comms.once('stop', cb);
    lora_comms.stop();
});

after(function (cb)
{
    if (!lora_comms.logging_active)
    {
        return cb();
    }

    lora_comms.once('logging_stop', cb);
    // no need to call lora_comms.stop_logging(), logging_stop will be emitted
    // once the log streams end
});

describe('echoing device', function ()
{
    it('should receive same data sent', function (cb)
    {
        setTimeout(cb, 1000);

    });
});

// test logging
