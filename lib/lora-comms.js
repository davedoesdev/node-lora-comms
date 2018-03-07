process.env.UV_THREADPOOL_SIZE = (process.env.UV_THREADPOOL_SIZE || 4) + 5;

const stream = require('stream'),
      EventEmitter = require('events').EventEmitter,
      LoRaComms = require('bindings')('lora_comms').LoRaComms;

LoRaComms.set_gw_send_hwm(LoRaComms.uplink, -1);
LoRaComms.set_gw_send_timeout(LoRaComms.uplink, -1, -1);
LoRaComms.set_gw_recv_timeout(LoRaComms.uplink, -1, -1);

LoRaComms.set_gw_send_hwm(LoRaComms.downlink, -1);
LoRaComms.set_gw_send_timeout(LoRaComms.downlink, -1, -1);
LoRaComms.set_gw_recv_timeout(LoRaComms.downlink, -1, -1);

LoRaComms.set_log_max_msg_size(1024);
LoRaComms.set_log_write_hwm(-1);
LoRaComms.set_log_write_timeout(-1, -1);

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
        let buf = Buffer.alloc(LoRaComms.get_log_max_msg_size());
        this._get_log_message(buf, -1, -1, (err, r) =>
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
        this._logging_active = false;
        this._logging_needs_reset = false;
    }

    get active()
    {
        return this._active;
    }

    get logging_active()
    {
        return this._logging_active;
    }

    start(options)
    {
        options = options || {};

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

        if (options.no_streams)
        {
            this.uplink = null;
            this.downlink = null;
        }
        else
        {
            this.uplink = new LinkDuplex(LoRaComms.uplink, options);
            this.downlink = new LinkDuplex(LoRaComms.downlink, options);
        }

        LoRaComms.start(options.cfg_dir, err => process.nextTick(() =>
        {
            this._active = false;

            if (this.uplink)
            {
                this.uplink.push(null);
                this.uplink.end();
            }

            if (this.downlink)
            {
                this.downlink.push(null);
                this.downlink.end();
            }

            if (err)
            {
                this.emit('error', err);
            }

            this.emit('stop');
        }));
    }

    stop()
    {
        LoRaComms.stop();
    }

    start_logging(options)
    {
        if (this._logging_active)
        {
            return;
        }

        if (this._logging_needs_reset)
        {
            LoRaComms.reset_logging();
        }

        this._logging_active = true;
        this._logging_needs_reset = true;

        this.log_info = new LogReadable(LoRaComms.get_log_info_message,
                                        options);
        this.log_error = new LogReadable(LoRaComms.get_log_error_message,
                                         options);

        let end_count = 0, check = () =>
        {
            if (++end_count === 2)
            {
                this._logging_active = false;
                this.emit('logging_stop');
            }
        };
        this.log_info.on('end', check);
        this.log_error.on('end', check);

        LoRaComms.start_logging();
    }

    stop_logging()
    {
        LoRaComms.stop_logging();
        this.log_info.push(null);
        this.log_error.push(null);
    }
}();
