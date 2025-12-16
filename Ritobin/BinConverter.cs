using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

namespace Jade.Ritobin;

public static class BinConverter
{
    private static Task? _preloadTask = null;
    
    public static void StartPreloading(string hashDir)
    {
        _preloadTask = HashManager.LoadAsync(hashDir);
    }
    
    public static string ConvertBinToText(string binPath, string? hashDir = null, bool keepHashesLoaded = true)
    {
        var totalSw = Stopwatch.StartNew();
        var sw = Stopwatch.StartNew();
        
        // Read file to check format
        var data = File.ReadAllBytes(binPath);
        
        // Check if it's already a text file (starts with "#PROP_text")
        if (data.Length > 10)
        {
            var header = Encoding.ASCII.GetString(data, 0, Math.Min(10, data.Length));
            if (header.StartsWith("#PROP"))
            {
                Console.WriteLine("[BinConverter] File is already in text format, returning as-is");
                return Encoding.UTF8.GetString(data);
            }
        }
        
        // Wait for preload to finish if it's running
        if (_preloadTask != null && !_preloadTask.IsCompleted)
        {
            Console.WriteLine("[BinConverter] Waiting for hash preload to complete...");
            _preloadTask.Wait();
            Console.WriteLine("[BinConverter] Hash preload completed");
        }
        
        bool wasLoaded = HashManager.IsLoaded;
        
        if (hashDir != null && !wasLoaded)
        {
            sw.Restart();
            HashManager.Load(hashDir);
            Console.WriteLine($"[BinConverter] HashManager.Load: {sw.ElapsedMilliseconds}ms");
        }
        else if (wasLoaded)
        {
            Console.WriteLine("[BinConverter] Hashes already loaded (using preloaded)");
        }

        sw.Restart();
        Console.WriteLine($"[BinConverter] File.ReadAllBytes: {sw.ElapsedMilliseconds}ms");

        sw.Restart();
        var reader = new BinReader(data);
        var bin = reader.Read();
        Console.WriteLine($"[BinConverter] BinReader.Read: {sw.ElapsedMilliseconds}ms");

        sw.Restart();
        var unhasher = new BinUnhasher();
        unhasher.UnhashBin(bin);
        Console.WriteLine($"[BinConverter] BinUnhasher.UnhashBin: {sw.ElapsedMilliseconds}ms");

        sw.Restart();
        var writer = new BinTextWriter();
        var result = writer.Write(bin);
        Console.WriteLine($"[BinConverter] BinTextWriter.Write: {sw.ElapsedMilliseconds}ms");
        
        // Unload hashes if user doesn't want to keep them loaded
        if (!keepHashesLoaded && hashDir != null && HashManager.IsLoaded)
        {
            sw.Restart();
            HashManager.Unload();
            Console.WriteLine($"[BinConverter] HashManager.Unload: {sw.ElapsedMilliseconds}ms");
        }
        
        Console.WriteLine($"[BinConverter] TOTAL: {totalSw.ElapsedMilliseconds}ms");
        
        // Force immediate collection of Bin object to free memory
        // The Bin object can be ~500MB and should be freed immediately after conversion
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        
        return result;
    }
    
    public static byte[]? ConvertTextToBin(string textContent, out string? error, string? hashDir = null)
    {
        error = null;
        
        try
        {
            // Parse text back to Bin object
            var reader = new BinTextReader(textContent);
            var bin = reader.ReadBin();
            
            if (bin == null)
            {
                error = reader.GetErrors();
                return null;
            }
            
            // Write to binary format
            var writer = new BinWriter();
            return writer.Write(bin);
        }
        catch (Exception ex)
        {
            error = $"Conversion error: {ex.Message}";
            return null;
        }
    }
}
