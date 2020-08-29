/**
 * Module for reading and writing LoRa packets.
 * @module lora-comms
 * @extends events.EventEmitter
 */
"use strict";

process.env.UV_THREADPOOL_SIZE = (process.env.UV_THREADPOOL_SIZE || 4) + 5;

const stream = require('stream'),
      path = require('path'),
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
        this._reading = false;
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
        if (this._reading) { return; }
        this._reading = true;

        let buf = Buffer.alloc(LoRaComms.recv_from_buflen);
        LoRaComms.recv_from(this._link, buf, -1, -1, (err, r) =>
        {
            this._reading = false;
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
                process.nextTick(() => this._read());
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

class lora_comms extends EventEmitter
{
    get LoRaComms()
    {
        return LoRaComms;
    }

    constructor()
    {
        super();
        this._uplink = null;
        this._downlink = null;
        this._active = false;
        this._needs_reset = false;
        this._log_info = null;
        this._log_error = null;
        this._logging_active = false;
        this._logging_needs_reset = false;
    }

    /**
     * Start the LoRa radio, receiving and transmitting packets to
     * {@link lora-commsuplink|uplink} and {@link lora-commsdownlink|downlink}.
     *
     * @memberof lora-comms
     * @param {Object} options - Configuration options. This is passed to stream.Duplex when constructing {@link lora-commsuplink|uplink} and {@link lora-commsdownlink|downlink} and supports the following additional option:
     * @param {string} [options.cfg_dir] - Path to directory containing LoRa radio configuration files. Defaults to `packet_forwarder_shared/lora_pkt_fwd` in the module directory.
     */
    start(options)
    {
		options = Object.assign(
		{
			cfg_dir: path.join(__dirname, '..',
                               'packet_forwarder_shared', 'lora_pkt_fwd')
		}, options);

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
            this._uplink = null;
            this._downlink = null;
        }
        else
        {
            this._uplink = new LinkDuplex(LoRaComms.uplink, options);
            this._downlink = new LinkDuplex(LoRaComms.downlink, options);
        }

        LoRaComms.start(options.cfg_dir, err => process.nextTick(() =>
        {
            this._active = false;

            if (this._uplink)
            {
                this._uplink.push(null);
                this._uplink.end();
            }

            if (this._downlink)
            {
                this._downlink.push(null);
                this._downlink.end();
            }

            if (err)
            {
                this.emit('error', err);
            }

            this.emit('stop');
        }));
    }

	/**
     * Stop the LoRa radio.
	 *
	 * A {@link lora-comms.event:stop|stop} event is emitted when the radio
     * stops.
     *
     * @memberof lora-comms
	 */
    stop()
    {
        LoRaComms.stop();
    }

    /**
     * Duplex stream for receiving packets from the LoRa radio.
     * Read `PUSH_DATA` packets. Write `PUSH_ACK` packets.
     *
     * @memberof lora-comms
     * @type {?stream.Duplex}
     */
    get uplink()
    {
        return this._uplink;
    }

    /**
     * Duplex stream for transmitting packets using the LoRa radio.
     * Read `PULL_DATA` and `TX_ACK` packets. Write `PULL_ACK` and `PULL_RESP`
     * packets.
     *
     * @memberof lora-comms
     * @type {?stream.Duplex}
     */
    get downlink()
    {
        return this._downlink;
    }

    /**
     * Whether the LoRa radio is switched on.
     *
     * @memberof lora-comms
     * @type {boolean}
     */
    get active()
    {
        return this._active;
    }

	/**
     * Start logging diagnostic messages to
     * {@link lora-commslog_info|log_info} and
     * {@link lora-commslog_error|log_error}.
     *
     * @memberof lora-comms
     * @param {Object} options - Configuration options. This is passed to stream.Readable when constructing {@link lora-commslog_info|log_info} and {@link lora-commslog_error|log_error}.
     */
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

        this._log_info = new LogReadable(LoRaComms.get_log_info_message,
                                         options);
        this._log_error = new LogReadable(LoRaComms.get_log_error_message,
                                          options);

        let end_count = 0, check = () =>
        {
            if (++end_count === 2)
            {
                this._logging_active = false;
                this.emit('logging_stop');
            }
        };
        this._log_info.on('end', check);
        this._log_error.on('end', check);

        LoRaComms.start_logging();
    }

	/**
     * Stop logging diagnostic messages.
     *
	 * A {@link lora-comms.event:logging_stop|logging_stop} event is emitted
     * when logging stops.
     *
     * @memberof lora-comms
     */
    stop_logging()
    {
        LoRaComms.stop_logging();
        this._log_info.push(null);
        this._log_error.push(null);
    }

    /**
     * Readable stream containing diagnostic messages.
     *
     * @memberof lora-comms
     * @type {?stream.Readable}
     */
    get log_info()
    {
        return this._log_info;
    }

    /**
     * Readable stream containing diagnostic messages.
     *
     * @memberof lora-comms
     * @type {?stream.Readable}
     */
    get log_error()
    {
        return this._log_error;
    }

    /**
     * Whether diagnostic logging is enabled.
     *
     * @memberof lora-comms
     * @type {boolean}
     */
    get logging_active()
    {
        return this._logging_active;
    }

    /**
     * Stop event. Emitted when the radio stops.
     *
     * @memberof lora-comms
     * @event stop
     */

    /**
     * Logging stop event. Emitted when logging stops.
     *
     * @memberof lora-comms
     * @event logging_stop
     */

    /**
     * Error event.
     *
     * @memberof lora-comms
     * @event error
     * @param {Object} err - The error which occurred.
     */
}

module.exports = new lora_comms();
