#include <mutex>
#include <condition_variable>
#include <queue>
#include <chrono>
#include <napi.h>
#include <lora_comms.h>

using namespace std::chrono_literals;

template<typename Duration>
class LogQueue
{
public:
    typedef std::queue<std::string> queue_t;

    void reset()
    {
        closed = false;
        close_pending = false;
    }

    void close(bool immediately)
    {
        std::unique_lock<std::mutex> lock(m);

        close_pending = true;

        if (immediately || q.empty())
        {
            queue_t empty;
            std::swap(q, empty);
            size = 0;
            closed = true;
            recv_cv.notify_all();
        }
    }

    ssize_t write(const std::vector<char> &msg,
                  ssize_t hwm,
                  const Duration &timeout)
    {
        std::unique_lock<std::mutex> lock(m);

        if (closed)
        {
            errno = EBADF;
            return -1;
        }

        if ((hwm >= 0) && (size > hwm))
        {
            // wait until buffered data size <= hwm
            auto pred = [this, hwm]
            {
                return closed || (this->size <= hwm);
            };

            if (timeout < Duration::zero())
            {
                // timeout < 0 means block
                send_cv.wait(lock, pred);
            }
            else if ((timeout == Duration::zero()) ||
                     !send_cv.wait_for(lock, timeout, pred))
            {
                errno = EAGAIN;
                return -1;
            }

            if (closed)
            {
                errno = EBADF;
                return -1;
            }
        }

        q.emplace(msg.data());
        ssize_t r = q.back().size();
        size += r;
        recv_cv.notify_all();

        return r;
    }

    ssize_t read(std::string &msg, const Duration &timeout)
    {
        std::unique_lock<std::mutex> lock(m);

        if (closed)
        {
            errno = EBADF;
            return -1;
        }

        if (q.empty())
        {
            if (close_pending)
            {
                closed = true;
                errno = EBADF;
                return -1;
            }

            auto pred = [this]
            {
                return closed || !this->q.empty();
            };

            if (timeout < Duration::zero())
            {
                // timeout < 0 means block
                recv_cv.wait(lock, pred);
            }
            else if ((timeout == Duration::zero()) ||
                     !recv_cv.wait_for(lock, timeout, pred))
            {
                errno = EAGAIN;
                return -1;
            }

            if (closed)
            {
                errno = EBADF;
                return -1;
            }
        }

        msg = q.front();
        q.pop();
        size -= msg.size();
        send_cv.notify_all();

        return msg.size();
    }

private:
    std::mutex m;
    std::condition_variable send_cv, recv_cv;
    queue_t q;
    ssize_t size = 0;
    bool closed = false;
    bool close_pending = false;
};

class LoRaComms : public Napi::ObjectWrap<LoRaComms>
{
public:
    LoRaComms(const Napi::CallbackInfo& info);

    static Napi::Object Initialize(Napi::Env env, Napi::Object exports);

private:
    friend class StartAsyncWorker;

    static void Start(const Napi::CallbackInfo& info);
    static void Stop(const Napi::CallbackInfo& info);
    static void Reset(const Napi::CallbackInfo& info);

    static void RecvFrom(const Napi::CallbackInfo& info);
    static void SendTo(const Napi::CallbackInfo& info);

    static void SetGWSendHWM(const Napi::CallbackInfo& info);
    static void SetGWSendTimeout(const Napi::CallbackInfo& info);
    static void SetGWRecvTimeout(const Napi::CallbackInfo& info);

    static void StartLogging(const Napi::CallbackInfo& info);
    static void StopLogging(const Napi::CallbackInfo& info);
    static void GetLogInfoMessage(const Napi::CallbackInfo& info);
    static void GetLogErrorMessage(const Napi::CallbackInfo& info);
    static void SetLogMaxMessageSize(const Napi::CallbackInfo& info);
    static void SetLogWriteHWM(const Napi::CallbackInfo& info);
    static void SetLogWriteTimeout(const Napi::CallbackInfo& info);
    static int Logger(FILE *stream, const char *format, va_list ap);

    static struct timeval TimeVal(const Napi::CallbackInfo& info,
                                  const uint32_t arg);

    static std::chrono::microseconds Microseconds(
            const Napi::CallbackInfo& info,
            const uint32_t arg);

    static size_t log_max_msg_size;
    static ssize_t log_write_hwm;
    static std::chrono::microseconds log_write_timeout;
    static LogQueue<std::chrono::microseconds> log_info, log_error;
};

size_t LoRaComms::log_max_msg_size = 1024;
ssize_t LoRaComms::log_write_hwm = -1;
std::chrono::microseconds LoRaComms::log_write_timeout = -1us;
LogQueue<std::chrono::microseconds> LoRaComms::log_info, LoRaComms::log_error;

LoRaComms::LoRaComms(const Napi::CallbackInfo& info) :
    Napi::ObjectWrap<LoRaComms>(info)
{
}

Napi::Error ErrnoError(const Napi::Env& env, const int errnum)
{
    char buf[1024] = {0};
    auto errmsg = strerror_r(errnum, buf, sizeof(buf));
    static_assert(std::is_same<decltype(errmsg), char*>::value,
                  "strerror_r must return char*");
    Napi::Error err = Napi::Error::New(env, errmsg ? errmsg : std::to_string(errnum));
    err.Set("errno", Napi::Number::New(env, errnum));
    return err;
}

class StartAsyncWorker : public Napi::AsyncWorker
{
public:
    StartAsyncWorker(const Napi::Function& callback,
                     const Napi::String& cfg_dir) :
        Napi::AsyncWorker(callback),
        cfg_dir(cfg_dir.Utf8Value())
    {
    }

protected:
    void Execute() override
    {
        if (start(cfg_dir.empty() ? nullptr : cfg_dir.c_str()) != EXIT_SUCCESS)
        {
            SetError("failed");
        }

        LoRaComms::log_info.close(false);
        LoRaComms::log_error.close(false);
    }

private:
    std::string cfg_dir;
};

void LoRaComms::Start(const Napi::CallbackInfo& info)
{
    (new StartAsyncWorker(info[1].As<Napi::Function>(),
                          info[0].As<Napi::String>()))
        ->Queue();
}

class StopAsyncWorker : public Napi::AsyncWorker
{
public:
    StopAsyncWorker(const Napi::Function& callback) :
        Napi::AsyncWorker(callback)
    {
    }

protected:
    void Execute() override
    {
        stop();
    }
};

void LoRaComms::Stop(const Napi::CallbackInfo& info)
{
    (new StopAsyncWorker(info[0].As<Napi::Function>()))->Queue();
}

void LoRaComms::Reset(const Napi::CallbackInfo& info)
{
    reset();
}

class CommsAsyncWorker : public Napi::AsyncWorker
{
public:
    CommsAsyncWorker(const Napi::Function& callback,
                     const int link,
                     const Napi::Buffer<uint8_t>& buffer,
                     const struct timeval& timeout) :
        Napi::AsyncWorker(callback),
        link(link),
        buf(buffer.Data()),
        len(buffer.Length()),
        timeout(timeout),
        buffer_ref(Napi::Persistent(buffer))
    {
    }

protected:
    virtual ssize_t Communicate() = 0;

    void Execute() override
    {
        result = Communicate();
        if (result < 0)
        {
            errnum = errno;
        }
    }

    void OnOK() override
    {
        Napi::Env env = Env();
        Callback().MakeCallback(
            Receiver().Value(),
            std::initializer_list<napi_value>
            {
                result < 0 ? ErrnoError(env, errnum).Value() : env.Null(),
                Napi::Number::New(env, result)
            });
    }

    int link;
    void *buf;
    size_t len;
    struct timeval timeout;

private:
    Napi::Reference<Napi::Buffer<uint8_t>> buffer_ref;
    ssize_t result;
    int errnum;
};

class RecvFromAsyncWorker : public CommsAsyncWorker
{
public:
    RecvFromAsyncWorker(const Napi::Function& callback,
                        const int link,
                        const Napi::Buffer<uint8_t>& buffer,
                        const struct timeval& timeout) :
        CommsAsyncWorker(callback, link, buffer, timeout)
    {
    }

protected:
    ssize_t Communicate() override
    {
        return recv_from(link, buf, len, &timeout);
    }
};

void LoRaComms::RecvFrom(const Napi::CallbackInfo& info)
{
    (new RecvFromAsyncWorker(info[4].As<Napi::Function>(),
                             info[0].As<Napi::Number>(),
                             info[1].As<Napi::Buffer<uint8_t>>(),
                             TimeVal(info, 2)))
        ->Queue();
}

class SendToAsyncWorker : public CommsAsyncWorker
{
public:
    SendToAsyncWorker(const Napi::Function& callback,
                      const int link,
                      const Napi::Buffer<uint8_t>& buffer,
                      ssize_t hwm,
                      const struct timeval& timeout) :
        CommsAsyncWorker(callback, link, buffer, timeout),
        hwm(hwm)
    {
    }

protected:
    ssize_t Communicate() override
    {
        return send_to(link, buf, len, hwm, &timeout);
    }

private:
    ssize_t hwm;
};

void LoRaComms::SendTo(const Napi::CallbackInfo& info)
{
    (new SendToAsyncWorker(info[5].As<Napi::Function>(),
                           info[0].As<Napi::Number>(),
                           info[1].As<Napi::Buffer<uint8_t>>(),
                           info[2].As<Napi::Number>(),
                           TimeVal(info, 3)))
        ->Queue();
}

void LoRaComms::SetGWSendHWM(const Napi::CallbackInfo& info)
{
    set_gw_send_hwm(info[0].As<Napi::Number>(), info[1].As<Napi::Number>());
}

void LoRaComms::SetGWSendTimeout(const Napi::CallbackInfo& info)
{
    struct timeval tv = TimeVal(info, 1);
    set_gw_send_timeout(info[0].As<Napi::Number>(), &tv);
}

void LoRaComms::SetGWRecvTimeout(const Napi::CallbackInfo& info)
{
    struct timeval tv = TimeVal(info, 1);
    set_gw_recv_timeout(info[0].As<Napi::Number>(), &tv);
}

void LoRaComms::StartLogging(const Napi::CallbackInfo& info)
{
    set_logger(Logger);
}

void LoRaComms::StopLogging(const Napi::CallbackInfo& info)
{
    set_logger(nullptr);
    log_info.close(true);
    log_error.close(true);
}

class LogAsyncWorker : public Napi::AsyncWorker
{
public:
    LogAsyncWorker(const Napi::Function& callback,
                   LogQueue<std::chrono::microseconds> *q,
                   const std::chrono::microseconds &timeout) :
        Napi::AsyncWorker(callback),
        q(q),
        timeout(timeout)
    {
    }

protected:
    void Execute() override
    {
        result = q->read(msg, timeout);
        if (result < 0)
        {
            errnum = errno;
        }
    }

    void OnOK() override
    {
        Napi::Env env = Env();
        Callback().MakeCallback(
            Receiver().Value(),
            std::initializer_list<napi_value>
            {
                result < 0 ? ErrnoError(env, errnum).Value() : env.Null(),
                Napi::String::New(env, msg)
            });
    }

private:
    LogQueue<std::chrono::microseconds> *q;
    std::chrono::microseconds timeout;
    std::string msg;
    ssize_t result;
    int errnum;
};

void LoRaComms::GetLogInfoMessage(const Napi::CallbackInfo& info)
{
    (new LogAsyncWorker(info[2].As<Napi::Function>(),
                        &log_info,
                        Microseconds(info, 0)))
        ->Queue();
}

void LoRaComms::GetLogErrorMessage(const Napi::CallbackInfo& info)
{
    (new LogAsyncWorker(info[2].As<Napi::Function>(),
                        &log_error,
                        Microseconds(info, 0)))
        ->Queue();
}

void LoRaComms::SetLogMaxMessageSize(const Napi::CallbackInfo& info)
{
    log_max_msg_size = static_cast<uint32_t>(info[0].As<Napi::Number>());
}

void LoRaComms::SetLogWriteHWM(const Napi::CallbackInfo& info)
{
    log_write_hwm = info[0].As<Napi::Number>();
}

void LoRaComms::SetLogWriteTimeout(const Napi::CallbackInfo& info)
{
    log_write_timeout = Microseconds(info, 0);
}

int LoRaComms::Logger(FILE *stream, const char *format, va_list ap)
{
    std::vector<char> msg(log_max_msg_size);
    vsnprintf(msg.data(), log_max_msg_size, format, ap);

    if (stream == stdout)
    {
        return log_info.write(msg, log_write_hwm, log_write_timeout);
    }

    if (stream == stderr)
    {
        return log_error.write(msg, log_write_hwm, log_write_timeout);
    }

    errno = EINVAL;
    return -1;
}

typedef std::conditional<sizeof(time_t) == 8, int64_t, int32_t>::type tm_t;

struct timeval LoRaComms::TimeVal(const Napi::CallbackInfo& info,
                                  const uint32_t arg)
{
    struct timeval tv;
    tv.tv_sec = static_cast<tm_t>(info[arg].As<Napi::Number>());
    tv.tv_usec = static_cast<tm_t>(info[arg+1].As<Napi::Number>());
    return tv;
}

std::chrono::microseconds LoRaComms::Microseconds(
            const Napi::CallbackInfo& info,
            const uint32_t arg)
{
    return static_cast<tm_t>(info[arg].As<Napi::Number>()) * 1s +
           static_cast<tm_t>(info[arg+1].As<Napi::Number>()) * 1us;
}

Napi::Object LoRaComms::Initialize(Napi::Env env, Napi::Object exports)
{
    exports.Set("LoRaComms", DefineClass(env, "LoRaComms",
    {
        StaticMethod("start", &Start),
        StaticMethod("stop", &Stop),
        StaticMethod("reset", &Reset),

        StaticMethod("recv_from", &RecvFrom),
        StaticMethod("send_to", &SendTo),

        StaticValue("uplink", Napi::Number::New(env, uplink)),
        StaticValue("downlink", Napi::Number::New(env, downlink)),

        StaticMethod("set_gw_send_hwm", &SetGWSendHWM),
        StaticMethod("set_gw_send_timeout", &SetGWSendTimeout),
        StaticMethod("set_gw_recv_timeout", &SetGWRecvTimeout),

        StaticMethod("start_logging", &StartLogging),
        StaticMethod("stop_logging", &StopLogging),
        StaticMethod("get_log_info_message", &GetLogInfoMessage),
        StaticMethod("get_log_error_message", &GetLogErrorMessage),
        StaticMethod("set_log_max_msg_size", &SetLogMaxMessageSize),
        StaticMethod("set_log_write_hwm", &SetLogWriteHWM),
        StaticMethod("set_log_write_timeout", &SetLogWriteTimeout),

        StaticValue("EBADF", Napi::Number::New(env, EBADF)),
        StaticValue("EAGAIN", Napi::Number::New(env, EAGAIN)),

        StaticValue("recv_from_buflen", Napi::Number::New(env, recv_from_buflen)),
        StaticValue("send_to_buflen", Napi::Number::New(env, send_to_buflen))
    }));

    return exports;
}

Napi::Object Initialize(Napi::Env env, Napi::Object exports)
{
    return LoRaComms::Initialize(env, exports);
}

NODE_API_MODULE(lora_comms, Initialize)
