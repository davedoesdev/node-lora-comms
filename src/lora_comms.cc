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

    void Start(const Napi::CallbackInfo& info);
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

Napi::Object LoRaComms::Initialize(Napi::Env env, Napi::Object exports)
{
    exports.Set("LoRaComms", DefineClass(env, "LoRaComms",
    {
        InstanceMethod("start", &LoRaComms::Start)
    }));

    return exports;
}

Napi::Object Initialize(Napi::Env env, Napi::Object exports)
{
    return LoRaComms::Initialize(env, exports);
}

NODE_API_MODULE(lora_comms, Initialize)
