using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.Marshalling;
using System.Text;
using System.Threading.Channels;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;
using NAudio.Wasapi.CoreAudioApi.Interfaces;
using NAudio.Wave;

namespace Vlanya.WindowAudioCapture;

internal static class Program
{
    private const int OutputSampleRate = 48000;
    private const int OutputChannels = 1;

    [MTAThread]
    private static async Task<int> Main(string[] args)
    {
        try
        {
            var options = CaptureOptions.Parse(args);
            if (options.ShowHelp)
            {
                PrintUsage();
                return 0;
            }

            var processId = options.ProcessId ?? ResolveProcessId(options);
            if (processId <= 0)
            {
                Console.Error.WriteLine("ERR no target process");
                return 2;
            }

            using var stop = new CancellationTokenSource();
            if (options.DurationMs is > 0)
            {
                stop.CancelAfter(options.DurationMs.Value);
            }

            Console.CancelKeyPress += (_, eventArgs) =>
            {
                eventArgs.Cancel = true;
                stop.Cancel();
            };

            if (options.DurationMs is null)
            {
                _ = Task.Run(() =>
                {
                    try
                    {
                        while (!stop.IsCancellationRequested && Console.In.Read() >= 0)
                        {
                        }
                    }
                    catch
                    {
                        // Stdin goes away when Electron closes the capture pipe.
                    }
                    stop.Cancel();
                });
            }

            await using var capture = await ProcessLoopbackCapture.CreateAsync(processId, options.ProcessLoopbackMode, stop.Token);
            await using var output = Console.OpenStandardOutput();
            var writer = Channel.CreateUnbounded<byte[]>(new UnboundedChannelOptions
            {
                SingleReader = true,
                SingleWriter = false,
                AllowSynchronousContinuations = false,
            });

            capture.DataAvailable += data =>
            {
                if (data.Length > 0) writer.Writer.TryWrite(data);
            };
            capture.Stopped += error =>
            {
                if (error is null) writer.Writer.TryComplete();
                else writer.Writer.TryComplete(error);
            };

            var processName = TryGetProcessName(processId);
            Console.Error.WriteLine($"READY pid={processId} process={processName} mode={options.ProcessLoopbackMode} sampleRate={OutputSampleRate} channels={OutputChannels}");

            capture.Start();

            await foreach (var chunk in writer.Reader.ReadAllAsync(stop.Token))
            {
                await output.WriteAsync(chunk, stop.Token);
                await output.FlushAsync(stop.Token);
            }

            return 0;
        }
        catch (OperationCanceledException)
        {
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"ERR 0x{error.HResult:X8} {error.Message}");
            return 1;
        }
    }

    private static void PrintUsage()
    {
        Console.Error.WriteLine("Usage: Vlanya.WindowAudioCapture --pid <pid> [--duration-ms <ms>]");
        Console.Error.WriteLine("   or: Vlanya.WindowAudioCapture --hwnd <windowHandle> [--duration-ms <ms>]");
        Console.Error.WriteLine("       add --exclude-tree to capture everything except the target process tree");
    }

    private static int ResolveProcessId(CaptureOptions options)
    {
        if (options.WindowHandle is > 0)
        {
            _ = NativeMethods.GetWindowThreadProcessId(new IntPtr(options.WindowHandle.Value), out var processId);
            if (processId > 0) return unchecked((int)processId);
        }

        if (!string.IsNullOrWhiteSpace(options.WindowTitle))
        {
            return ResolveProcessIdByWindowTitle(options.WindowTitle);
        }

        return 0;
    }

    private static int ResolveProcessIdByWindowTitle(string expectedTitle)
    {
        var normalizedExpected = NormalizeWindowTitle(expectedTitle);
        if (string.IsNullOrWhiteSpace(normalizedExpected)) return 0;

        var bestProcessId = 0;
        var bestScore = 0;
        NativeMethods.EnumWindows((window, _) =>
        {
            if (!NativeMethods.IsWindowVisible(window)) return true;
            var length = NativeMethods.GetWindowTextLengthW(window);
            if (length <= 0) return true;

            var builder = new StringBuilder(length + 1);
            NativeMethods.GetWindowTextW(window, builder, builder.Capacity);
            var title = NormalizeWindowTitle(builder.ToString());
            if (string.IsNullOrWhiteSpace(title)) return true;

            var score = ScoreWindowTitle(normalizedExpected, title);
            if (score > bestScore)
            {
                NativeMethods.GetWindowThreadProcessId(window, out var processId);
                if (processId > 0)
                {
                    bestScore = score;
                    bestProcessId = unchecked((int)processId);
                }
            }

            return true;
        }, IntPtr.Zero);

        return bestScore > 0 ? bestProcessId : 0;
    }

    private static string NormalizeWindowTitle(string value) =>
        value.Trim().Replace('\u2014', '-').Replace('\u2013', '-').ToLowerInvariant();

    private static int ScoreWindowTitle(string expected, string actual)
    {
        if (actual.Equals(expected, StringComparison.Ordinal)) return 100;
        if (actual.Contains(expected, StringComparison.Ordinal)) return 80;
        if (expected.Contains(actual, StringComparison.Ordinal)) return 60;
        return 0;
    }

    private static string TryGetProcessName(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            return process.ProcessName;
        }
        catch
        {
            return "unknown";
        }
    }

    private sealed class ProcessLoopbackCapture : IAsyncDisposable
    {
        private static readonly WaveFormat CaptureFormat = WaveFormat.CreateIeeeFloatWaveFormat(OutputSampleRate, 2);
        private readonly AudioClient audioClient;
        private readonly EventWaitHandle sampleReady = new(false, EventResetMode.AutoReset);
        private readonly CancellationTokenSource stop = new();
        private readonly Task captureTask;
        private bool started;

        private ProcessLoopbackCapture(AudioClient audioClient)
        {
            this.audioClient = audioClient;
            audioClient.Initialize(
                AudioClientShareMode.Shared,
                AudioClientStreamFlags.EventCallback
                    | AudioClientStreamFlags.Loopback
                    | AudioClientStreamFlags.AutoConvertPcm
                    | AudioClientStreamFlags.SrcDefaultQuality,
                0,
                0,
                CaptureFormat,
                Guid.Empty);
            audioClient.SetEventHandle(sampleReady.SafeWaitHandle.DangerousGetHandle());
            captureTask = Task.Run(CaptureLoop);
        }

        public event Action<byte[]>? DataAvailable;
        public event Action<Exception?>? Stopped;

        public static async Task<ProcessLoopbackCapture> CreateAsync(
            int processId,
            ProcessLoopbackMode processLoopbackMode,
            CancellationToken cancellationToken)
        {
            var audioClient = await ProcessLoopbackActivator.ActivateAsync(processId, processLoopbackMode, cancellationToken);
            return new ProcessLoopbackCapture(audioClient);
        }

        public void Start()
        {
            if (started) return;
            started = true;
            audioClient.Start();
        }

        private void CaptureLoop()
        {
            Exception? error = null;
            try
            {
                var capture = audioClient.AudioCaptureClient;
                while (!stop.IsCancellationRequested)
                {
                    sampleReady.WaitOne(100);
                    ReadPackets(capture);
                }
            }
            catch (Exception ex)
            {
                error = ex;
            }
            finally
            {
                try
                {
                    audioClient.Stop();
                }
                catch
                {
                    // The audio client can already be stopped during shutdown.
                }
                Stopped?.Invoke(error);
            }
        }

        private void ReadPackets(AudioCaptureClient capture)
        {
            var packetFrames = capture.GetNextPacketSize();
            while (packetFrames > 0)
            {
                var buffer = capture.GetBuffer(out var framesAvailable, out var flags, out _, out _);
                try
                {
                    var bytes = ConvertPacketToMonoFloat32(buffer, framesAvailable, flags);
                    if (bytes.Length > 0) DataAvailable?.Invoke(bytes);
                }
                finally
                {
                    capture.ReleaseBuffer(framesAvailable);
                }

                packetFrames = capture.GetNextPacketSize();
            }
        }

        private static byte[] ConvertPacketToMonoFloat32(IntPtr buffer, int framesAvailable, AudioClientBufferFlags flags)
        {
            if (framesAvailable <= 0) return [];

            var outputBytes = new byte[framesAvailable * sizeof(float)];
            var outputFloats = MemoryMarshal.Cast<byte, float>(outputBytes.AsSpan());

            if ((flags & AudioClientBufferFlags.Silent) == AudioClientBufferFlags.Silent || buffer == IntPtr.Zero)
            {
                outputFloats.Clear();
                return outputBytes;
            }

            unsafe
            {
                var input = (float*)buffer.ToPointer();
                for (var frame = 0; frame < framesAvailable; frame += 1)
                {
                    var left = input[(frame * 2)];
                    var right = input[(frame * 2) + 1];
                    outputFloats[frame] = Math.Clamp((left + right) * 0.5f, -1.0f, 1.0f);
                }
            }

            return outputBytes;
        }

        public async ValueTask DisposeAsync()
        {
            stop.Cancel();
            sampleReady.Set();
            try
            {
                await captureTask.ConfigureAwait(false);
            }
            catch
            {
                // Disposal should never crash Electron's helper shutdown.
            }

            sampleReady.Dispose();
            stop.Dispose();
            audioClient.Dispose();
        }
    }

    private static class ProcessLoopbackActivator
    {
        private const string ProcessLoopbackDevice = "VAD\\Process_Loopback";
        private static readonly Guid IAudioClientId = new("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");

        public static async Task<AudioClient> ActivateAsync(
            int processId,
            ProcessLoopbackMode processLoopbackMode,
            CancellationToken cancellationToken)
        {
            var activationParams = new AudioClientActivationParams
            {
                ActivationType = AudioClientActivationType.ProcessLoopback,
                ProcessLoopbackParams = new AudioClientProcessLoopbackParams
                {
                    TargetProcessId = unchecked((uint)processId),
                    ProcessLoopbackMode = processLoopbackMode,
                },
            };

            var activationParamsPtr = Marshal.AllocHGlobal(Marshal.SizeOf<AudioClientActivationParams>());
            var propVariantPtr = IntPtr.Zero;
            try
            {
                Marshal.StructureToPtr(activationParams, activationParamsPtr, false);
                var propVariant = new PropVariant
                {
                    VarType = (ushort)VarEnum.VT_BLOB,
                    Blob = new Blob
                    {
                        Length = Marshal.SizeOf<AudioClientActivationParams>(),
                        Data = activationParamsPtr,
                    },
                };
                propVariantPtr = Marshal.AllocHGlobal(Marshal.SizeOf<PropVariant>());
                Marshal.StructureToPtr(propVariant, propVariantPtr, false);

                var handler = new ActivationCompletionHandler();
                var hr = NativeMethods.ActivateAudioInterfaceAsync(
                    ProcessLoopbackDevice,
                    IAudioClientId,
                    propVariantPtr,
                    handler,
                    out _);
                if (hr < 0) Marshal.ThrowExceptionForHR(hr);

                var rawAudioClient = await handler.Task.WaitAsync(TimeSpan.FromSeconds(8), cancellationToken)
                    .ConfigureAwait(false);
                return new AudioClient(rawAudioClient);
            }
            finally
            {
                if (propVariantPtr != IntPtr.Zero) Marshal.FreeHGlobal(propVariantPtr);
                Marshal.FreeHGlobal(activationParamsPtr);
            }
        }
    }

    private sealed class ActivationCompletionHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        private readonly TaskCompletionSource<IAudioClient> completion = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task<IAudioClient> Task => completion.Task;

        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation)
        {
            try
            {
                activateOperation.GetActivateResult(out var hr, out var activatedInterface);
                if (hr < 0)
                {
                    completion.TrySetException(Marshal.GetExceptionForHR(hr) ?? new COMException("Audio activation failed.", hr));
                    return;
                }

                completion.TrySetResult((IAudioClient)activatedInterface);
            }
            catch (Exception error)
            {
                completion.TrySetException(error);
            }
        }
    }

    private sealed class CaptureOptions
    {
        public int? ProcessId { get; private init; }
        public long? WindowHandle { get; private init; }
        public string? WindowTitle { get; private init; }
        public ProcessLoopbackMode ProcessLoopbackMode { get; private init; }
        public int? DurationMs { get; private init; }
        public bool ShowHelp { get; private init; }

        public static CaptureOptions Parse(string[] args)
        {
            int? processId = null;
            long? windowHandle = null;
            string? windowTitle = null;
            var processLoopbackMode = ProcessLoopbackMode.IncludeTargetProcessTree;
            int? durationMs = null;
            var showHelp = args.Length == 0;

            for (var index = 0; index < args.Length; index += 1)
            {
                var arg = args[index];
                string Next()
                {
                    if (index + 1 >= args.Length) throw new ArgumentException($"Missing value for {arg}");
                    index += 1;
                    return args[index];
                }

                switch (arg)
                {
                    case "--pid":
                        processId = int.Parse(Next());
                        break;
                    case "--hwnd":
                        windowHandle = ParseWindowHandle(Next());
                        break;
                    case "--window-title":
                        windowTitle = Next();
                        break;
                    case "--duration-ms":
                        durationMs = int.Parse(Next());
                        break;
                    case "--exclude-tree":
                        processLoopbackMode = ProcessLoopbackMode.ExcludeTargetProcessTree;
                        break;
                    case "--include-tree":
                        processLoopbackMode = ProcessLoopbackMode.IncludeTargetProcessTree;
                        break;
                    case "--help":
                    case "-h":
                    case "/?":
                        showHelp = true;
                        break;
                    default:
                        throw new ArgumentException($"Unknown argument: {arg}");
                }
            }

            if (!showHelp && processId is null && windowHandle is null && string.IsNullOrWhiteSpace(windowTitle))
            {
                throw new ArgumentException("Pass --pid, --hwnd, or --window-title.");
            }

            return new CaptureOptions
            {
                ProcessId = processId,
                WindowHandle = windowHandle,
                WindowTitle = windowTitle,
                ProcessLoopbackMode = processLoopbackMode,
                DurationMs = durationMs,
                ShowHelp = showHelp,
            };
        }

        private static long ParseWindowHandle(string value)
        {
            if (value.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            {
                return Convert.ToInt64(value[2..], 16);
            }

            return long.Parse(value);
        }
    }

    private static class NativeMethods
    {
        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowTextLengthW(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);

        [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = true)]
        public static extern int ActivateAudioInterfaceAsync(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
            [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
            IntPtr activationParams,
            IActivateAudioInterfaceCompletionHandler completionHandler,
            out IActivateAudioInterfaceAsyncOperation activationOperation);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AudioClientActivationParams
    {
        public AudioClientActivationType ActivationType;
        public AudioClientProcessLoopbackParams ProcessLoopbackParams;
    }

    private enum AudioClientActivationType
    {
        Default = 0,
        ProcessLoopback = 1,
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AudioClientProcessLoopbackParams
    {
        public uint TargetProcessId;
        public ProcessLoopbackMode ProcessLoopbackMode;
    }

    private enum ProcessLoopbackMode
    {
        IncludeTargetProcessTree = 0,
        ExcludeTargetProcessTree = 1,
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct PropVariant
    {
        [FieldOffset(0)]
        public ushort VarType;

        [FieldOffset(8)]
        public Blob Blob;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Blob
    {
        public int Length;
        public IntPtr Data;
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90")]
    private interface IAgileObject
    {
    }
}
