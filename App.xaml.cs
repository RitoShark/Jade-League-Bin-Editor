using System;
using System.IO;
using System.IO.Pipes;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using Jade.Windows;

namespace Jade;

public partial class App : Application
{
    private const string MutexName = "JadeBinEditor_SingleInstance_Mutex";
    private const string PipeName = "JadeBinEditor_SingleInstance_Pipe";
    
    private static Mutex? _mutex;
    private CancellationTokenSource? _pipeServerCts;
    
    public static string? StartupFilePath { get; private set; }
    
    protected override void OnStartup(StartupEventArgs e)
    {
        string? filePath = e.Args.Length > 0 ? e.Args[0] : null;
        
        // Try to create mutex - if we can't, another instance is running
        _mutex = new Mutex(true, MutexName, out bool isNewInstance);
        
        if (!isNewInstance)
        {
            // Another instance is running - send file path to it and exit
            if (!string.IsNullOrEmpty(filePath))
            {
                SendFilePathToExistingInstance(filePath);
            }
            else
            {
                // Just bring existing window to front (send empty message)
                SendFilePathToExistingInstance("__ACTIVATE__");
            }
            
            Shutdown();
            return;
        }
        
        // We are the first instance
        base.OnStartup(e);
        
        if (!string.IsNullOrEmpty(filePath))
        {
            StartupFilePath = filePath;
            Services.Logger.Info($"Application started with file argument: {StartupFilePath}");
        }
        
        // Start listening for messages from other instances
        StartPipeServer();
    }
    
    protected override void OnExit(ExitEventArgs e)
    {
        _pipeServerCts?.Cancel();
        _mutex?.ReleaseMutex();
        _mutex?.Dispose();
        base.OnExit(e);
    }
    
    private void SendFilePathToExistingInstance(string filePath)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out);
            client.Connect(1000); // 1 second timeout
            
            using var writer = new StreamWriter(client);
            writer.WriteLine(filePath);
            writer.Flush();
            
            Services.Logger.Info($"Sent file path to existing instance: {filePath}");
        }
        catch (Exception ex)
        {
            Services.Logger.Error("Failed to send file path to existing instance", ex);
        }
    }
    
    private void StartPipeServer()
    {
        _pipeServerCts = new CancellationTokenSource();
        var token = _pipeServerCts.Token;
        
        Task.Run(async () =>
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    using var server = new NamedPipeServerStream(PipeName, PipeDirection.In);
                    await server.WaitForConnectionAsync(token);
                    
                    using var reader = new StreamReader(server);
                    var message = await reader.ReadLineAsync();
                    
                    if (!string.IsNullOrEmpty(message))
                    {
                        // Dispatch to UI thread
                        await Dispatcher.InvokeAsync(async () =>
                        {
                            var mainWindow = MainWindow as MainWindow;
                            if (mainWindow != null)
                            {
                                // Bring window to front
                                if (mainWindow.WindowState == WindowState.Minimized)
                                    mainWindow.WindowState = WindowState.Normal;
                                mainWindow.Activate();
                                mainWindow.Focus();
                                
                                // Open file if it's not just an activation request
                                if (message != "__ACTIVATE__" && File.Exists(message))
                                {
                                    await mainWindow.OpenFileFromPathAsync(message);
                                }
                            }
                        });
                    }
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    Services.Logger.Error("Pipe server error", ex);
                }
            }
        }, token);
        
        Services.Logger.Info("Pipe server started for single-instance support");
    }
}
