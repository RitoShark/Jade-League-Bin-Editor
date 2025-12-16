using System;
using System.IO;

namespace Jade.Services;

/// <summary>
/// Simple logging service for debugging
/// </summary>
public static class Logger
{
    private static readonly string LogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "RitoShark", "Jade", "jade.log");
    
    private static readonly object _lock = new object();

    static Logger()
    {
        try
        {
            var logDir = Path.GetDirectoryName(LogPath);
            if (logDir != null && !Directory.Exists(logDir))
            {
                Directory.CreateDirectory(logDir);
            }
            
            // Clear old log on startup
            if (File.Exists(LogPath))
            {
                File.Delete(LogPath);
            }
            
            Log("INFO", "Jade started");
            Log("INFO", $"Log file: {LogPath}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Failed to initialize logger: {ex.Message}");
        }
    }

    public static void Info(string message)
    {
        Log("INFO", message);
    }

    public static void Error(string message, Exception? ex = null)
    {
        Log("ERROR", message);
        if (ex != null)
        {
            Log("ERROR", $"Exception: {ex.GetType().Name}");
            Log("ERROR", $"Message: {ex.Message}");
            Log("ERROR", $"StackTrace: {ex.StackTrace}");
        }
    }

    public static void Debug(string message)
    {
        Log("DEBUG", message);
    }

    private static void Log(string level, string message)
    {
        try
        {
            lock (_lock)
            {
                var timestamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff");
                var logMessage = $"[{timestamp}] [{level}] {message}";
                
                File.AppendAllText(LogPath, logMessage + Environment.NewLine);
                Console.WriteLine(logMessage);
            }
        }
        catch
        {
            // Silently fail if logging fails
        }
    }

    public static string GetLogPath() => LogPath;
}
