const Duplex = require('stream').Duplex,
      EventEmitter = require('events').EventEmitter,
      LoRaComms = require('bindings')('lora_comms').LoRaComms;

class LinkDuplex extends Duplex
{
    constructor(link, finish_end, options)
    {
        super(options);
        this._link = link;
        this.on('finish', finish_end);
        this.on('end', finish_end);
    }

    _write(data, encoding, cb)
    {
        LoRaComms.send_to(this._link, data, -1, -1, -1, (err, r) =>
        {
            if (err)
            {
                if (err.errno === LoRaComms.EBADF)
                {
                    this.end();
                }

                return cb(err);
            }

            if (r !== data.length)
            {
                return cb(new Error('not all data was written'));
            }

            cb();
        });
    }

    _read()
    {
        let buf = Buffer.alloc(LoRaComms.recv_from_buflen);
        LoRaComms.recv_from(this._link, buf, -1, -1, (err, r) =>
        {
            if (err)
            {
                if (err.errno === LoRaComms.EBADF)
                {
                    return this.push(null);
                }

                return process.nextTick(() => this.emit('error', err));
            }

            if (this.push(buf.slice(0, r)))
            {
                process.nextTick(() => this.read());
            }
        });
    }
}

module.exports = new class extends EventEmitter
{
    get LoRaComms()
    {
        return LoRaComms;
    }

    constructor()
    {
        super();
        this._active = false;
        this._needs_reset = false;
    }

    start(options)
    {
        if (this._active)
        {
            return;
        }

        if (this._needs_reset)
        {
            LoRaComms.reset();
        }

        this._needs_reset = true;

        let finished_ended = 0,
            stopped = false;

        let check = err =>
        {
// PROBLEM is if app isn't reading or writing, we don't get to 4
            if ((finished_ended === 4) && stopped)
            {
                this._active = false;
                this.uplink = null;
                this.downlink = null;

                if (err)
                {
                    this.emit('error', err);
                }

                this.emit('stop');
            }
            else if (err)
            {
                this.emit('error', err);
            }
        };

        let finish_end = () =>
        {
            finished_ended += 1;
            check();
        };

        this.uplink = new LinkDuplex(LoRaComms.uplink,
                                     finish_end,
                                     options);

        this.downlink = new LinkDuplex(LoRaComms.downlink,
                                       finish_end,
                                       options);

        this._active = true;

        LoRaComms.start(options.cfg_dir, err =>
        {
            stopped = true;
            check(err);
        });
    }

    stop()
    {
        LoRaComms.stop(() => {});
    }
}();
