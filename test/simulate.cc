#include <string.h>
#include <mutex>
#include <condition_variable>
#include <atomic>
#include <queue>
#include <chrono>
#include <lora_comms_int.h>

const size_t NB_PKT_MAX = 8;
const size_t STATUS_SIZE = 200;
const size_t TX_BUFF_SIZE = ((540 * NB_PKT_MAX) + 30 + STATUS_SIZE);
const size_t RX_BUFF_SIZE = 1000;

const size_t recv_from_buflen = TX_BUFF_SIZE;
const size_t send_to_buflen = RX_BUFF_SIZE - 1;

const uint8_t PROTOCOL_VERSION = 2;
const uint8_t PUSH_DATA = 0;
const uint8_t PUSH_ACK = 1;
const uint8_t PULL_DATA = 2;
const uint8_t PULL_RESP = 3;
const uint8_t PULL_ACK = 4;
const uint8_t TX_ACK = 5;

using namespace std::chrono_literals;

template<typename Duration, typename Element>
class WaitQueue {
protected:
    template<class Test>
    void maybe_reset(Test test) {
        std::unique_lock<std::mutex> lock(m);
        if (test()) {
            closed = false;
        }
    }

    template<class Test>
    void maybe_close(Test test) {
        std::unique_lock<std::mutex> lock(m);
        if (test()) {
            decltype(q) empty;
            std::swap(q, empty);
            size = 0;
            closed = true;
            send_cv.notify_all();
            recv_cv.notify_all();
        }
    }

    template<class Enqueue>
    int enqueue(ssize_t hwm, const Duration &timeout, Enqueue enqueue) {
        std::unique_lock<std::mutex> lock(m);

        if (closed) {
            errno = EBADF;
            return -1;
        }

        if (hwm == 0) {
            return 0;
        }

        if ((hwm > 0) && (size >= hwm)) {
            int err = wait_for_hwm(hwm, timeout, lock);
            if (err != 0)
            {
                errno = err;
                return -1;
            }
        }

        return enqueue();
    }

    template<class Dequeue>
    int dequeue(const Duration &timeout, Dequeue dequeue) {
        std::unique_lock<std::mutex> lock(m);

        if (closed) {
            errno = EBADF;
            return -1;
        }

        if (q.empty()) {
            int err = wait_for_not_empty(timeout, lock);
            if (err != 0)
            {
                errno = err;
                return -1;
            }
        }

        return dequeue();
    }

    virtual int wait_for_hwm(ssize_t hwm,
                             const Duration &timeout,
                             std::unique_lock<std::mutex>& lock) {
        return wait(timeout, lock, send_cv, [this, hwm] {
            // wait until buffered data size < hwm
            return (size < hwm);
        });
    }

    virtual int wait_for_not_empty(const Duration &timeout,
                                   std::unique_lock<std::mutex>& lock)
    {
        return wait(timeout, lock, recv_cv, [this] {
            // wait until queue isn't empty
            return !q.empty();
        });
    }

    std::mutex m;
    std::condition_variable send_cv, recv_cv;
    std::queue<Element> q;
    ssize_t size = 0;
    bool closed = false;

private:
    template<class Predicate>
    int wait(const Duration &timeout,
             std::unique_lock<std::mutex>& lock,
             std::condition_variable& cv,
             Predicate pred) {
        auto closed_or_pred = [this, pred] {
            return closed || pred();
        };

        if (timeout < Duration::zero()) {
            // timeout < 0 means block
            cv.wait(lock, closed_or_pred);
        } else if ((timeout == Duration::zero()) ||
                 !cv.wait_for(lock, timeout, closed_or_pred)) {
            return EAGAIN;
        }

        if (closed) {
            return EBADF;
        }

        return 0;
    }
};

template<typename Duration>
class Queue : public WaitQueue<Duration, std::vector<uint8_t>>
{
public:
    Queue(const size_t send_buflen) :
        send_buflen(send_buflen) {
    }

    void reset() {
        this->maybe_reset([] { return true; });
    }

    void close() {
        this->maybe_close([] { return true; });
    }

    ssize_t send(const void *buf, size_t len,
                 ssize_t hwm, const Duration &timeout) {
        return this->enqueue(hwm, timeout, [this, buf, len] {
            auto bytes = static_cast<const uint8_t*>(buf);
            size_t len2 = std::min(send_buflen, len);
            this->q.emplace(bytes, &bytes[len2]);
            this->size += len2;
            this->recv_cv.notify_all();
            return len2;
        });
    }

    ssize_t recv(void *buf, size_t len, const Duration &timeout) {
        return this->dequeue(timeout, [this, buf, len] {
            auto &el = this->q.front();
            ssize_t r = std::min(el.size(), len);
            memcpy(buf, el.data(), r);
            this->q.pop();
            this->size -= el.size();
            this->send_cv.notify_all();
            return r;
        });
    }

protected:
    size_t send_buflen;
};

template<typename Duration>
class LogQueue : public Queue<Duration>
{
public:
    LogQueue(const size_t send_buflen = 1024,
             const ssize_t write_hwm = -1,
             const Duration &write_timeout = -1us) :
        Queue<Duration>(send_buflen),
        write_hwm(write_hwm),
        write_timeout(write_timeout) {
    }

    void reset() {
        this->maybe_reset([this] {
            close_pending = false;
            return true;
        });
    }

    void close(bool immediately) {
        this->maybe_close([this, immediately] {
            close_pending = true;
            return (immediately || this->q.empty());
        });
    }

    ssize_t write(const char *format, va_list ap) {
        std::vector<char> msg(this->send_buflen + 1);
        int n = vsnprintf(msg.data(), this->send_buflen + 1, format, ap);
        if (n <= 0) {
            return n;
        }
        return this->send(msg.data(), n, write_hwm, write_timeout);
    }

    void set_write_hwm(ssize_t hwm) {
        write_hwm = hwm;
    }

    void set_write_timeout(const Duration &timeout) {
        write_timeout = timeout;
    }

    void set_max_msg_size(size_t max_size) {
        this->send_buflen = max_size;
    }

    size_t get_max_msg_size() {
        return this->send_buflen;
    }

protected:
    int wait_for_not_empty(const Duration &timeout,
                           std::unique_lock<std::mutex>& lock) override {
        if (close_pending) {
            this->closed = true;
            return EBADF;
        }

        return Queue<Duration>::wait_for_not_empty(timeout, lock);
    }

private:
    bool close_pending = false;
    ssize_t write_hwm;
    Duration write_timeout;
};

class Link {
public:
    Link() : 
        from_fwd(recv_from_buflen),
        to_fwd(send_to_buflen) {
    }

    void reset() {
        from_fwd_send_hwm = -1;
        from_fwd_send_timeout = -1us;
        to_fwd_recv_timeout = -1us;
        from_fwd.reset();
        to_fwd.reset();
    }

    void close() {
        from_fwd.close();
        to_fwd.close();
    }

    void set_from_fwd_send_hwm(const ssize_t hwm) {
        from_fwd_send_hwm = hwm;
    }

    void set_from_fwd_send_timeout(const std::chrono::microseconds &timeout) {
        from_fwd_send_timeout = timeout;
    }

    void set_to_fwd_recv_timeout(const std::chrono::microseconds &timeout) {
        to_fwd_recv_timeout = timeout;
    }

    ssize_t from_fwd_send(const void *buf, size_t len) {
        return from_fwd.send(buf, len,
                             from_fwd_send_hwm, from_fwd_send_timeout);
    }

    ssize_t from_fwd_recv(void *buf, size_t len,
                          const std::chrono::microseconds &timeout) {
        return from_fwd.recv(buf, len, timeout);
    }

    ssize_t to_fwd_send(const void *buf, size_t len,
                        ssize_t hwm, const std::chrono::microseconds &timeout) {
        return to_fwd.send(buf, len, hwm, timeout);
    }

    ssize_t to_fwd_recv(void *buf, size_t len) {
        return to_fwd.recv(buf, len, to_fwd_recv_timeout);
    }

private:
    ssize_t from_fwd_send_hwm = -1;
    std::chrono::microseconds from_fwd_send_timeout = -1us;
    std::chrono::microseconds to_fwd_recv_timeout = -1us;
    Queue<std::chrono::microseconds> from_fwd, to_fwd;
};

static Link links[2];
static LogQueue<std::chrono::microseconds> log_info, log_error;
static std::atomic<logger_fn> logger(nullptr);
static bool stop_requested = false;
static std::mutex stop_mutex;

struct ExitException : public std::exception {
    ExitException(int status) : status(status) {}
    int status;
};

static std::chrono::microseconds to_microseconds(const struct timeval *tv) {
    return tv ? (tv->tv_sec * 1s + tv->tv_usec * 1us) : -1us;
}

int log(LogQueue<std::chrono::microseconds>& logq, const char *format, ...) {
    va_list ap;
    va_start(ap, format);

    return logq.write(format, ap);
}

int start(const char *cfg_dir) {
    if (strcmp(cfg_dir, "foobar") == 0) {
        return EXIT_FAILURE;
    }

    int r = EXIT_SUCCESS;

    try {
        log(log_info, "Waiting for stop");
        while (true) {
            std::unique_lock<std::mutex> lock(stop_mutex);
            if (stop_requested) {
                break;
            }
        }
    }
    catch (ExitException &e) {
        r = e.status;
    }

    links[uplink].close();
    links[downlink].close();

    return r;
}

ssize_t recv_from(enum comm_link link,
                  void *buf, size_t len,
                  const struct timeval *timeout) {
    if (link < 0) {
        if ((link < -1 - downlink) || (link > -1 - uplink)) {
            errno = EINVAL;
            return -1;
        }

        return links[-1 - link].to_fwd_recv(buf, len);
    }

    if ((link < uplink) || (link > downlink)) {
        errno = EINVAL;
        return -1;
    }

    return links[link].from_fwd_recv(buf, len, to_microseconds(timeout));
}

ssize_t send_to(enum comm_link link,
                const void *buf, size_t len,
                ssize_t hwm, const struct timeval *timeout) {
    if (link < 0) {
        if ((link < -1 - downlink) || (link > -1 - uplink)) {
            errno = EINVAL;
            return -1;
        }

        return links[-1 - link].from_fwd_send(buf, len);
    }

    if ((link < uplink) || (link > downlink)) {
        errno = EINVAL;
        return -1;
    }

    return links[link].to_fwd_send(buf, len, hwm, to_microseconds(timeout));
}

void set_logger(logger_fn f) {
    logger = f;
}

int log_to_queues(FILE *stream, const char *format, va_list ap) {
    auto log = &log_error;

    if (stream == stdout)
    {
        log = &log_info;
    }

    return log->write(format, ap);
}

void close_log_queues(bool immediately) {
    log_info.close(immediately);
    log_error.close(immediately);
}

ssize_t get_log_info_message(char *msg, size_t len,
                             const struct timeval *timeout) {
    return log_info.recv(msg, len, to_microseconds(timeout));
}

ssize_t get_log_error_message(char *msg, size_t len,
                              const struct timeval *timeout) {
    return log_error.recv(msg, len, to_microseconds(timeout));
}

void set_gw_send_hwm(enum comm_link link, const ssize_t hwm) {
    if ((link < uplink) || (link > downlink)) {
        return;
    }

    links[link].set_from_fwd_send_hwm(hwm);
}

void set_gw_send_timeout(enum comm_link link, const struct timeval *timeout) {
    if ((link < uplink) || (link > downlink)) {
        return;
    }

    links[link].set_from_fwd_send_timeout(to_microseconds(timeout));
}

void set_gw_recv_timeout(enum comm_link link, const struct timeval *timeout) {
    if ((link < uplink) || (link > downlink)) {
        return;
    }

    links[link].set_to_fwd_recv_timeout(to_microseconds(timeout));
}

void set_log_write_hwm(ssize_t hwm) {
    log_info.set_write_hwm(hwm);
    log_error.set_write_hwm(hwm);
}

void set_log_write_timeout(const struct timeval *timeout) {
    auto timeout_ms = to_microseconds(timeout);
    log_info.set_write_timeout(timeout_ms);
    log_error.set_write_timeout(timeout_ms);
}

void set_log_max_msg_size(size_t max_size) {
    log_info.set_max_msg_size(max_size);
    log_error.set_max_msg_size(max_size);
}

size_t get_log_max_msg_size() {
    return std::max(log_info.get_max_msg_size(),
                    log_error.get_max_msg_size());
}

void stop() {
    std::unique_lock<std::mutex> lock(stop_mutex);
    stop_requested = true;
}

void reset_log_queues() {
    log_info.reset();
    log_error.reset();
}

void reset() {
    links[uplink].reset();
    links[downlink].reset();
    stop_requested = false;
}
