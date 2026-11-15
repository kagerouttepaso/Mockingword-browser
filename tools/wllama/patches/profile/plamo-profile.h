#pragma once
#include <cstdint>
#include <utility>

// profile 専用。同期・投入・sampling の意味を変えず、呼出しの経過時間を記録する。
namespace plamo_profile {
enum Metric { decode, build, bind_group, write_buffer, submit, queue_wait, map_wait,
              sampling, tensor_read, host_copy, event_wait, llama_graph, backend_sched, metric_count };
double now();
bool active();
void logits(uint64_t rows, uint64_t bytes);
void batch(uint64_t tokens, uint64_t prefill_tokens, uint64_t decode_tokens);
void sequence(int64_t sequence_id, int64_t request_id);
void gpu(const char * pipeline, double ms);
void begin_step();
void end_step();
struct Step {
    Step() { begin_step(); }
    ~Step() { end_step(); }
};
struct Scope {
    Metric metric;
    double start;
    uint64_t bytes;
    double child_ms = 0;
    Scope * parent = nullptr;
    int node = -1;
    Scope(Metric metric, uint64_t bytes = 0);
    ~Scope();
    Scope(const Scope &) = delete;
    Scope & operator=(const Scope &) = delete;
};
template<class F> auto call(Metric metric, uint64_t bytes, F && fn) -> decltype(fn()) {
    Scope scope(metric, bytes);
    return fn();
}
}
