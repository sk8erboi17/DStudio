/* Minimal Microsoft::WRL::Callback replacement for MinGW-w64 builds.
 *
 * The upstream DStudio Windows build targets MSVC, whose Windows SDK ships a
 * full WRL implementation.  MinGW-w64 only ships <wrl.h> with ComPtr (the
 * implements/event headers are commented out), so DStudio compiled with the
 * MSYS2/MinGW toolchain needs this small shim.  It implements exactly the
 * three callback interfaces the Windows WebView2 wrapper uses, with the same
 * `Microsoft::WRL::Callback<Interface>(lambda).Get()` shape as the SDK API.
 */
#ifndef DS4_WRL_CALLBACK_COMPAT_H
#define DS4_WRL_CALLBACK_COMPAT_H

#include <wrl.h>
#include <windows.h>
#include <type_traits>
#include <utility>

namespace Microsoft {
namespace WRL {

namespace Details {

template <typename T>
class Ds4CallbackBase : public T {
public:
    STDMETHODIMP STDMETHODCALLTYPE QueryInterface(REFIID riid, void **ppv) override {
        (void)riid;
        if (!ppv) return E_POINTER;
        /* The WebView2 runtime only asks for the concrete callback interface
         * (or IUnknown), and both resolve to this object. */
        AddRef();
        *ppv = static_cast<T *>(this);
        return S_OK;
    }

    STDMETHODIMP_(ULONG) STDMETHODCALLTYPE AddRef() override {
        return (ULONG)InterlockedIncrement(&refs_);
    }

    STDMETHODIMP_(ULONG) STDMETHODCALLTYPE Release() override {
        ULONG r = (ULONG)InterlockedDecrement(&refs_);
        if (r == 0) delete this;
        return r;
    }

protected:
    Ds4CallbackBase() : refs_(1) {}
    virtual ~Ds4CallbackBase() {}

private:
    volatile LONG refs_;
};

} /* namespace Details */

template <typename T>
class Ds4CallbackPtr {
public:
    explicit Ds4CallbackPtr(T *p) : ptr_(p) {}
    ~Ds4CallbackPtr() {
        if (ptr_) ptr_->Release();
    }
    Ds4CallbackPtr(const Ds4CallbackPtr &) = delete;
    Ds4CallbackPtr &operator=(const Ds4CallbackPtr &) = delete;
    T *Get() const { return ptr_; }

private:
    T *ptr_;
};

template <typename F>
class Ds4EnvironmentCallback final
    : public Details::Ds4CallbackBase<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler> {
public:
    explicit Ds4EnvironmentCallback(F f) : fn_(std::move(f)) {}
    STDMETHODIMP STDMETHODCALLTYPE Invoke(HRESULT result,
                                          ICoreWebView2Environment *created_environment) override {
        return fn_(result, created_environment);
    }

private:
    F fn_;
};

template <typename F>
class Ds4ControllerCallback final
    : public Details::Ds4CallbackBase<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler> {
public:
    explicit Ds4ControllerCallback(F f) : fn_(std::move(f)) {}
    STDMETHODIMP STDMETHODCALLTYPE Invoke(HRESULT result,
                                          ICoreWebView2Controller *created_controller) override {
        return fn_(result, created_controller);
    }

private:
    F fn_;
};

template <typename F>
class Ds4MessageCallback final
    : public Details::Ds4CallbackBase<ICoreWebView2WebMessageReceivedEventHandler> {
public:
    explicit Ds4MessageCallback(F f) : fn_(std::move(f)) {}
    STDMETHODIMP STDMETHODCALLTYPE Invoke(ICoreWebView2 *sender,
                                          ICoreWebView2WebMessageReceivedEventArgs *args) override {
        return fn_(sender, args);
    }

private:
    F fn_;
};

template <typename T, typename F>
Ds4CallbackPtr<T> Callback(F &&f) {
    using decayed = typename std::decay<F>::type;
    if constexpr (std::is_same<T, ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>::value) {
        return Ds4CallbackPtr<T>(new Ds4EnvironmentCallback<decayed>(std::forward<F>(f)));
    } else if constexpr (std::is_same<T, ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>::value) {
        return Ds4CallbackPtr<T>(new Ds4ControllerCallback<decayed>(std::forward<F>(f)));
    } else if constexpr (std::is_same<T, ICoreWebView2WebMessageReceivedEventHandler>::value) {
        return Ds4CallbackPtr<T>(new Ds4MessageCallback<decayed>(std::forward<F>(f)));
    } else {
        static_assert(sizeof(T) == 0,
                      "Ds4Callback: unsupported interface; add a Ds4*Callback specialization");
    }
}

} /* namespace WRL */
} /* namespace Microsoft */

#endif /* DS4_WRL_CALLBACK_COMPAT_H */
