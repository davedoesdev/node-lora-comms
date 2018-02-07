const Duplex = require('stream').Duplex,
      EventEmitter = require('events').EventEmitter,
      LoRaComms = require('bindings')('lora_comms').LoRaComms;

class LinkDuplex extends Duplex
{
    constructor(link, options)
    {
        super(options);
        this._link = link;
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

        this._active = true;
        this._needs_reset = true;

        this.uplink = new LinkDuplex(LoRaComms.uplink, options);
        this.downlink = new LinkDuplex(LoRaComms.downlink, options);

        LoRaComms.start(options.cfg_dir, err =>
        {
            this._active = false;

            this.uplink.push(null);
            this.uplink.end();

            this.downlink.push(null);
            this.downlink.end();

            if (err)
            {
                this.emit('error', err);
            }

            this.emit('stop');
        });
    }

    stop()
    {
        LoRaComms.stop(() => {});
    }
}();
