#include <napi.h>
#include <lora_comms.h>

// call start on worker thread, callback when stopped
// map that to event in js land?
// then add the other methods

class LoRaComms : public Napi::ObjectWrap<LoRaComms>
{
public:
    LoRaComms(const Napi::CallbackInfo& info);

    static Napi::Object Initialize(Napi::Env env, Napi::Object exports);

private:
    static void Start(const Napi::CallbackInfo& info);
    static void Stop(const Napi::CallbackInfo& info);
    static void Reset(const Napi::CallbackInfo& info);

    static void SetGWSendHWM(const Napi::CallbackInfo& info);
    static void SetGWSendTimeout(const Napi::CallbackInfo& info);
    static void SetGWRecvTimeout(const Napi::CallbackInfo& info);

    static struct timeval *OptionalTimeVal(const Napi::CallbackInfo& info,
                                           struct timeval *tv,
                                           const uint32_t arg);
};

LoRaComms::LoRaComms(const Napi::CallbackInfo& info) :
    Napi::ObjectWrap<LoRaComms>(info)
{
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

void LoRaComms::SetGWSendHWM(const Napi::CallbackInfo& info)
{
    set_gw_send_hwm(info[0].As<Napi::Number>(), info[1].As<Napi::Number>());
}

struct timeval *LoRaComms::OptionalTimeVal(const Napi::CallbackInfo& info,
                                           struct timeval *ptv,
                                           const uint32_t arg)
{
    if ((info.Length() - arg) < 2)
    {
        return nullptr;
    }

    ptv->tv_sec = info[arg].As<Napi::Number>();
    ptv->tv_usec = info[arg+1].As<Napi::Number>();

    return ptv;
}

void LoRaComms::SetGWSendTimeout(const Napi::CallbackInfo& info)
{
    struct timeval tv;
    set_gw_send_timeout(info[0].As<Napi::Number>(),
                        OptionalTimeVal(info, &tv, 1));
}

void LoRaComms::SetGWRecvTimeout(const Napi::CallbackInfo& info)
{
    struct timeval tv;
    set_gw_recv_timeout(info[0].As<Napi::Number>(),
                        OptionalTimeVal(info, &tv, 1));
}

Napi::Object LoRaComms::Initialize(Napi::Env env, Napi::Object exports)
{
    exports.Set("LoRaComms", DefineClass(env, "LoRaComms",
    {
        StaticMethod("start", &Start),
        StaticMethod("stop", &Stop),
        StaticMethod("reset", &Reset),

        StaticMethod("set_gw_send_hwm", &SetGWSendHWM),
        StaticMethod("set_gw_send_timeout", &SetGWSendTimeout),
        StaticMethod("set_gw_recv_timeout", &SetGWRecvTimeout)
    }));

    return exports;
}

Napi::Object Initialize(Napi::Env env, Napi::Object exports)
{
    return LoRaComms::Initialize(env, exports);
}

NODE_API_MODULE(lora_comms, Initialize)
