#include "plamo-profile.h"
#include <emscripten.h>
#include <nlohmann/json.hpp>
#include <map>
#include <array>
#include <vector>
#include <cassert>

namespace plamo_profile {
using json = nlohmann::ordered_json;
struct Counter { uint64_t count = 0; double ms = 0; uint64_t bytes = 0; double self_ms = 0; };
static Counter counters[metric_count];
static const char * names[] = { "wasmDecode", "webgpuBuild", "bindGroup", "writeBuffer", "submit", "queueWait", "mapWait", "sampling", "tensorRead", "hostCopy", "eventWait", "llamaGraph", "backendScheduler" };
struct Node {
    Metric metric;
    int parent;
    Counter counter;
    std::array<int, metric_count> children;
    Node(Metric m, int p) : metric(m), parent(p) { children.fill(-1); }
};
static std::vector<Node> nodes;
static Scope * current_scope = nullptr;
static bool enabled = false;
static uint64_t step_id = 0, n_tokens = 0, n_prefill = 0, n_decode = 0, logits_rows = 0, logits_bytes = 0;
static double start = 0;
static std::map<int64_t, int64_t> sequences;
static std::map<std::string, std::pair<uint64_t, double>> gpu_times;
double now() { return emscripten_get_now(); }
bool active() { return enabled; }
Scope::Scope(Metric m, uint64_t b) : metric(m), start(-1), bytes(b) {
    if (!active()) return;
    start = now();
    parent = current_scope;
    const int parent_node = parent ? parent->node : 0;
    node = nodes[parent_node].children[metric];
    if (node < 0) {
        node = int(nodes.size());
        nodes.emplace_back(metric, parent_node);
        nodes[parent_node].children[metric] = node;
    }
    current_scope = this;
}
Scope::~Scope() {
    if (start < 0) return;
    assert(current_scope == this);
    const double elapsed = now() - start;
    const double self = elapsed - child_ms;
    current_scope = parent;
    if (parent) parent->child_ms += elapsed;
    else nodes[0].counter.ms += elapsed;
    for (Counter * counter : { &counters[metric], &nodes[node].counter }) {
        counter->count++; counter->ms += elapsed; counter->self_ms += self; counter->bytes += bytes;
    }
}
void logits(uint64_t rows, uint64_t bytes) { if (enabled) { logits_rows += rows; logits_bytes += bytes; } }
void batch(uint64_t tokens, uint64_t prefill_tokens, uint64_t decode_tokens) {
    if (enabled) { n_tokens += tokens; n_prefill += prefill_tokens; n_decode += decode_tokens; }
}
void sequence(int64_t sequence_id, int64_t request_id) { if (enabled) sequences[sequence_id] = request_id; }
void gpu(const char * pipeline, double ms) {
    if (enabled) { auto & value = gpu_times[pipeline]; value.first++; value.second += ms; }
}
void begin_step() {
    assert(current_scope == nullptr);
    enabled = true; ++step_id;
    for (auto & counter : counters) counter = {};
    n_tokens = n_prefill = n_decode = logits_rows = logits_bytes = 0;
    sequences.clear(); gpu_times.clear(); nodes.clear();
    nodes.emplace_back(metric_count, -1);
    start = now();
}
void end_step() {
    const double end = now();
    assert(current_scope == nullptr);
    enabled = false;
    json record = {{"kind", "step"}, {"decodeStepId", step_id}, {"startMs", start}, {"endMs", end}, {"ms", end - start},
        {"tokens", n_tokens}, {"prefillTokens", n_prefill}, {"decodeTokens", n_decode},
        {"phase", n_prefill ? (n_decode ? "mixed" : "prefill") : (n_decode ? "decode" : "idle")},
        {"logitsRows", logits_rows}, {"logitsBytes", logits_bytes}, {"metrics", json::object()},
        {"sequences", json::array()}, {"gpu", json::object()}};
    for (int i = 0; i < metric_count; ++i) record["metrics"][names[i]] = {{"count", counters[i].count}, {"ms", counters[i].ms}, {"selfMs", counters[i].self_ms}, {"bytes", counters[i].bytes}};
    record["scopeTree"] = json::array();
    const double outside_scopes = end - start - nodes[0].counter.ms;
    record["stepSelfMs"] = outside_scopes;
    record["scopeTree"].push_back({{"id", 0}, {"parentId", nullptr}, {"metric", "step"}, {"count", 1}, {"ms", end - start}, {"selfMs", outside_scopes}, {"bytes", 0}});
    for (size_t i = 1; i < nodes.size(); ++i) {
        const auto & node = nodes[i];
        record["scopeTree"].push_back({{"id", i}, {"parentId", node.parent}, {"metric", names[node.metric]}, {"count", node.counter.count},
            {"ms", node.counter.ms}, {"selfMs", node.counter.self_ms}, {"bytes", node.counter.bytes}});
    }
    for (const auto & item : sequences) record["sequences"].push_back({{"sequenceId", item.first}, {"requestId", item.second}});
    double gpu_ms = 0;
    uint64_t gpu_count = 0;
    for (const auto & item : gpu_times) {
        record["gpu"][item.first] = {{"count", item.second.first}, {"ms", item.second.second}};
        gpu_ms += item.second.second;
        gpu_count += item.second.first;
    }
    // timestamp が未収集の step は 0 ms の GPU 実行と区別する。
    record["gpuTotalMs"] = gpu_count ? json(gpu_ms) : json(nullptr);
    record["gpuKernelCount"] = gpu_count;
    record["gpuTimingStatus"] = gpu_count ? "collected" : "no-records";
    const std::string data = record.dump();
    // 既存の Worker 応答へまとめて載せる。step ごとの console/CDP 通知を増やさない。
    EM_ASM({ (globalThis.__plamoNative ||= []).push(JSON.parse(UTF8ToString(Number($0)))); }, data.c_str());
}
}
