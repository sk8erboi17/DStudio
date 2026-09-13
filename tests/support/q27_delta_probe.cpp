// Actual Metal recurrence, independently evaluated as scalar matrix algebra.
// No model weights or CUDA-parity claim. Keep the original upstream 2e-3
// scaled absolute tolerance; every state/output element and guard is checked.
#include "metal_backend.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <vector>

using Buffer = std::shared_ptr<q27::BackendBuffer>;
static constexpr float guard = 12345.25f;
static Buffer upload(q27::MetalBackend& b, const std::vector<float>& values) {
    auto out = b.allocate(values.size() * sizeof(float));
    b.write(*out, 0, values.data(), values.size() * sizeof(float));
    return out;
}
static std::vector<float> read(q27::MetalBackend& b, const Buffer& input, size_t n) {
    std::vector<float> out(n);
    b.read(*input, 0, out.data(), out.size() * sizeof(float));
    return out;
}
static void require(bool value, const char* message) {
    if (!value) throw std::runtime_error(message);
}
static double compare(const std::vector<float>& got, const std::vector<double>& want) {
    require(got.size() >= want.size(), "short result");
    double maximum = 0;
    for (size_t i = 0; i < want.size(); i++) {
        const double error = std::fabs(got[i] - want[i]);
        require(std::isfinite(got[i]) && error <= 2e-3 * std::max(1.0, std::fabs(want[i])),
                "independent recurrence oracle mismatch");
        maximum = std::max(maximum, error);
    }
    for (size_t i = want.size(); i < got.size(); i++) require(got[i] == guard, "output guard changed");
    return maximum;
}

static void run_case(q27::MetalBackend& backend, unsigned heads, unsigned tokens, bool inplace) {
    constexpr unsigned dim = 128, qk_heads = 16;
    const size_t state_n = size_t(heads) * dim * dim;
    const size_t conv_row = (2 * qk_heads + heads) * dim;
    const size_t out_row = heads * dim;
    std::vector<float> initial(state_n + 8, guard), conv(tokens * conv_row),
        g(tokens * heads), beta(g.size());
    for (size_t i = 0; i < state_n; i++) initial[i] = float(int((i * 19) % 61) - 30) * .001f;
    for (size_t i = 0; i < conv.size(); i++) conv[i] = float(int((i * 13) % 37) - 18) * .0025f;
    for (size_t i = 0; i < g.size(); i++) {
        g[i] = -.005f - float(i % 5) * .002f;
        beta[i] = .3f + float(i % 7) * .05f;
    }
    std::vector<double> expected(initial.begin(), initial.begin() + state_n), output(tokens * out_row);
    // Direct k^T S prediction, rank-one state update and q^T S output. This
    // does not share shader code, thread tiling or the four-part reduction.
    for (unsigned t = 0; t < tokens; t++) for (unsigned h = 0; h < heads; h++) {
        const size_t offset = size_t(h) * dim * dim, cv = size_t(t) * conv_row;
        const unsigned qk = h % qk_heads;
        const double decay = std::exp(double(g[t * heads + h]));
        for (unsigned j = 0; j < dim; j++) {
            double prediction = 0;
            for (unsigned i = 0; i < dim; i++)
                prediction += conv[cv + 2048 + qk * dim + i] * expected[offset + i * dim + j] * decay;
            const double delta = beta[t * heads + h] * (conv[cv + 4096 + h * dim + j] - prediction);
            double value = 0;
            for (unsigned i = 0; i < dim; i++) {
                double& state = expected[offset + i * dim + j];
                state = state * decay + conv[cv + 2048 + qk * dim + i] * delta;
                value += conv[cv + qk * dim + i] / std::sqrt(128.0) * state;
            }
            output[t * out_row + h * dim + j] = value;
        }
    }
    auto source = upload(backend, initial);
    auto destination = inplace ? source : upload(backend, std::vector<float>(state_n + 8, guard));
    auto cv = upload(backend, conv), gb = upload(backend, g), bb = upload(backend, beta);
    auto result = upload(backend, std::vector<float>(output.size() + 8, guard));
    const auto began = std::chrono::steady_clock::now();
    if (tokens == 1) backend.delta_step(*source, *destination, *cv, *gb, *bb, *result, heads, qk_heads, dim);
    else backend.delta_chunk(*source, *destination, *cv, *gb, *bb, *result, heads, qk_heads, dim, tokens);
    const auto actual_state = read(backend, destination, state_n + 8);
    const auto actual_output = read(backend, result, output.size() + 8);
    const double milliseconds = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - began).count();
    const double max_error = std::max(compare(actual_state, expected), compare(actual_output, output));
    if (!inplace) require(read(backend, source, initial.size()) == initial, "source state mutated");
    require(read(backend, cv, conv.size()) == conv && read(backend, gb, g.size()) == g &&
            read(backend, bb, beta.size()) == beta, "immutable recurrence input mutated");
    // Partition the same real sequence into serial dispatches. This comparison
    // is independent of the CPU oracle and must retain every token/output.
    auto serial = upload(backend, initial);
    std::vector<float> serial_output;
    for (unsigned t = 0; t < tokens; t++) {
        auto tc = upload(backend, std::vector<float>(conv.begin() + t * conv_row, conv.begin() + (t + 1) * conv_row));
        auto tg = upload(backend, std::vector<float>(g.begin() + t * heads, g.begin() + (t + 1) * heads));
        auto tb = upload(backend, std::vector<float>(beta.begin() + t * heads, beta.begin() + (t + 1) * heads));
        auto to = upload(backend, std::vector<float>(out_row + 8, guard));
        backend.delta_step(*serial, *serial, *tc, *tg, *tb, *to, heads, qk_heads, dim);
        auto row = read(backend, to, out_row + 8);
        for (size_t i = out_row; i < row.size(); i++) require(row[i] == guard, "serial output guard changed");
        serial_output.insert(serial_output.end(), row.begin(), row.begin() + out_row);
    }
    require(read(backend, serial, state_n + 8) == actual_state, "chunk/serial final state differs");
    require(std::equal(serial_output.begin(), serial_output.end(), actual_output.begin()), "chunk/serial output differs");
    std::printf("{\"heads\":%u,\"tokens\":%u,\"inplace\":%s,\"stateElements\":%zu,\"outputElements\":%zu,\"maxAbsoluteError\":%.9g,\"dispatchMilliseconds\":%.3f,\"passed\":true}\n",
                heads, tokens, inplace ? "true" : "false", state_n, output.size(), max_error, milliseconds);
}

int main() {
    try {
        q27::MetalBackend backend;
        for (unsigned heads : {1u, 3u, 48u}) for (unsigned tokens : {1u, 3u, 17u, 96u})
            for (bool inplace : {false, true}) run_case(backend, heads, tokens, inplace);
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what()); return 1;
    }
}
