#include <mutex>
#include <condition_variable>
#include <queue>
#include <chrono>
#include <napi.h>
#include <lora_comms.h>

using namespace std::chrono_literals;

// LoRaComms has no instance methods so we never create an instance
//LCOV_EXCL_START
class LoRaComms : public Napi::ObjectWrap<LoRaComms>
//LCOV_EXCL_STOP
{
public:
    LoRaComms(const Napi::CallbackInfo& info);

    static Napi::Object Initialize(Napi::Env env, Napi::Object exports);

private:
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
    static void ResetLogging(const Napi::CallbackInfo& info);
    static void GetLogInfoMessage(const Napi::CallbackInfo& info);
    static void GetLogErrorMessage(const Napi::CallbackInfo& info);
    static void SetLogWriteHWM(const Napi::CallbackInfo& info);
    static void SetLogWriteTimeout(const Napi::CallbackInfo& info);
    static void SetLogMaxMessageSize(const Napi::CallbackInfo& info);
    static Napi::Value GetLogMaxMessageSize(const Napi::CallbackInfo& info);

    static struct timeval TimeVal(const Napi::CallbackInfo& info,
                                  const uint32_t arg);
};

// LoRaComms has no instance methods so we never create an instance
//LCOV_EXCL_START
LoRaComms::LoRaComms(const Napi::CallbackInfo& info) :
    Napi::ObjectWrap<LoRaComms>(info)
{
}
//LCOV_EXCL_STOP

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

        close_log_queues(false);
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

void LoRaComms::Stop(const Napi::CallbackInfo& info)
{
    stop();
}

void LoRaComms::Reset(const Napi::CallbackInfo& info)
{
    reset();
}

class CommsAsyncWorker : public Napi::AsyncWorker
{
public:
    CommsAsyncWorker(const Napi::Function& callback,
                     const Napi::Buffer<uint8_t>& buffer,
                     const struct timeval& timeout) :
        Napi::AsyncWorker(callback),
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

    void *buf;
    size_t len;
    struct timeval timeout;

private:
    Napi::Reference<Napi::Buffer<uint8_t>> buffer_ref;
    ssize_t result;
    int errnum;
};

class LinkAsyncWorker : public CommsAsyncWorker
{
public:
    LinkAsyncWorker(const Napi::Function& callback,
                    const int link,
                    const Napi::Buffer<uint8_t>& buffer,
                    const struct timeval& timeout) :
        CommsAsyncWorker(callback, buffer, timeout),
        link(link)
    {
    }
/*
// Two versions of this are present in coverage, ~CommsAsyncWorker and
// ~CommsAsyncWorker.2. Only the latter gets called which leaves the former
// uncovered. The child classes' destructors are called (both versions).
//LCOV_EXCL_START
    ~LinkAsyncWorker()
    {
    }
//LCOV_EXCL_STOP
*/
protected:
    int link;
};

class RecvFromAsyncWorker : public LinkAsyncWorker
{
public:
    RecvFromAsyncWorker(const Napi::Function& callback,
                        const int link,
                        const Napi::Buffer<uint8_t>& buffer,
                        const struct timeval& timeout) :
        LinkAsyncWorker(callback, link, buffer, timeout)
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

class SendToAsyncWorker : public LinkAsyncWorker
{
public:
    SendToAsyncWorker(const Napi::Function& callback,
                      const int link,
                      const Napi::Buffer<uint8_t>& buffer,
                      ssize_t hwm,
                      const struct timeval& timeout) :
        LinkAsyncWorker(callback, link, buffer, timeout),
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
    set_logger(log_to_queues);
}

void LoRaComms::StopLogging(const Napi::CallbackInfo& info)
{
    set_logger(nullptr);
    close_log_queues(true);
}

void LoRaComms::ResetLogging(const Napi::CallbackInfo& info)
{
    reset_log_queues();
}

class LogAsyncWorker : public CommsAsyncWorker
{
public:
    LogAsyncWorker(const Napi::Function& callback,
                   get_log_message_fn get_log_message, 
                   const Napi::Buffer<uint8_t>& buffer,
                   const struct timeval& timeout) :
        CommsAsyncWorker(callback, buffer, timeout),
        get_log_message(get_log_message)
    {
    }

protected:
    ssize_t Communicate() override
    {
        return get_log_message(static_cast<char*>(buf), len, &timeout);
    }

private:
    get_log_message_fn get_log_message;
};

void LoRaComms::GetLogInfoMessage(const Napi::CallbackInfo& info)
{
    (new LogAsyncWorker(info[3].As<Napi::Function>(),
                        get_log_info_message,
                        info[0].As<Napi::Buffer<uint8_t>>(),
                        TimeVal(info, 1)))
        ->Queue();
}

void LoRaComms::GetLogErrorMessage(const Napi::CallbackInfo& info)
{
    (new LogAsyncWorker(info[3].As<Napi::Function>(),
                        get_log_error_message,
                        info[0].As<Napi::Buffer<uint8_t>>(),
                        TimeVal(info, 1)))
        ->Queue();
}

void LoRaComms::SetLogWriteHWM(const Napi::CallbackInfo& info)
{
    set_log_write_hwm(info[0].As<Napi::Number>());
}

void LoRaComms::SetLogWriteTimeout(const Napi::CallbackInfo& info)
{
    struct timeval tv = TimeVal(info, 0);
    set_log_write_timeout(&tv);
}

void LoRaComms::SetLogMaxMessageSize(const Napi::CallbackInfo& info)
{
    set_log_max_msg_size(static_cast<uint32_t>(info[0].As<Napi::Number>()));
}

Napi::Value LoRaComms::GetLogMaxMessageSize(const Napi::CallbackInfo& info)
{
    return Napi::Number::New(info.Env(), get_log_max_msg_size());
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
        StaticMethod("reset_logging", &ResetLogging),
        StaticMethod("get_log_info_message", &GetLogInfoMessage),
        StaticMethod("get_log_error_message", &GetLogErrorMessage),
        StaticMethod("set_log_write_hwm", &SetLogWriteHWM),
        StaticMethod("set_log_write_timeout", &SetLogWriteTimeout),
        StaticMethod("set_log_max_msg_size", &SetLogMaxMessageSize),
        StaticMethod("get_log_max_msg_size", &GetLogMaxMessageSize),

        StaticValue("EBADF", Napi::Number::New(env, EBADF)),
        StaticValue("EAGAIN", Napi::Number::New(env, EAGAIN)),
        StaticValue("EINVAL", Napi::Number::New(env, EINVAL)),

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
