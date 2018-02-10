process.env.UV_THREADPOOL_SIZE = (process.env.UV_THREADPOOL_SIZE || 4) + 5;

const stream = require('stream'),
      EventEmitter = require('events').EventEmitter,
      LoRaComms = require('bindings')('lora_comms').LoRaComms;

class LinkDuplex extends stream.Duplex
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

class LogReadable extends stream.Readable
{
    constructor(get_log_message, options)
    {
        super(options);
        this._get_log_message = get_log_message;
    }

    _read()
    {
        this._get_log_message(-1, -1, (err, r) =>
        {
            if (err)
            {
                if (err.errno === LoRaComms.EBADF)
                {
                    return this.push(null);
                }

                return process.nextTick(() => this.emit('error', err));
            }

            if (this.push(r))
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
        this._logging_active = false;
        this._logging_needs_reset = false;
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

        LoRaComms.start(options.cfg_dir, err => process.nextTick(() =>
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
        }));
    }

    stop()
    {
        LoRaComms.stop(() => {});
    }

    start_logging(options)
    {
        if (this._logging_active)
        {
            return;
        }

        if (this._logging_needs_reset)
        {
            LoRaComms.logging_reset();
        }

        this._logging_active = true;
        this._logging_needs_reset = true;

        this.log_info = new LogReadable(LoRaComms.get_log_info_message,
                                        options);
        this.log_error = new LogReadable(LoRaComms.get_log_error_message,
                                         options);
        LoRaComms.start_logging();
    }

    stop_logging()
    {
        LoRaComms.stop_logging();
        this._logging_active = false;
        this.log_info.push(null);
        this.log_error.push(null);
    }
}();
