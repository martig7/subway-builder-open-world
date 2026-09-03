using System.Threading;
using System.Windows.Threading;

namespace OpenWorld.Installer;

internal sealed class ManagerSingleInstance : IDisposable
{
    private const string MutexName = @"Local\SubwayBuilderOpenWorld.Manager";
    private const string ActivationEventName = @"Local\SubwayBuilderOpenWorld.Manager.Activate";
    private readonly Mutex mutex;
    private readonly EventWaitHandle activationEvent;
    private RegisteredWaitHandle? activationWait;
    private bool disposed;

    private ManagerSingleInstance(Mutex mutex, EventWaitHandle activationEvent)
    {
        this.mutex = mutex;
        this.activationEvent = activationEvent;
    }

    public static ManagerSingleInstance? AcquireOrActivateExisting()
    {
        var mutex = new Mutex(initiallyOwned: true, MutexName, out var createdNew);
        if (!createdNew)
        {
            mutex.Dispose();
            try
            {
                using var existingEvent = EventWaitHandle.OpenExisting(ActivationEventName);
                existingEvent.Set();
            }
            catch (WaitHandleCannotBeOpenedException) { }
            return null;
        }

        var activationEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ActivationEventName);
        return new ManagerSingleInstance(mutex, activationEvent);
    }

    public void Listen(Dispatcher dispatcher, Action activate)
    {
        activationWait = ThreadPool.RegisterWaitForSingleObject(
            activationEvent,
            (_, _) => dispatcher.BeginInvoke(activate),
            null,
            Timeout.Infinite,
            executeOnlyOnce: false);
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        activationWait?.Unregister(null);
        activationEvent.Dispose();
        mutex.ReleaseMutex();
        mutex.Dispose();
    }
}
