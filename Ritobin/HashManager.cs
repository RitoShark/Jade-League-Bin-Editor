using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime;
using System.Threading.Tasks;
using Jade.Services;

namespace Jade.Ritobin;

public static class HashManager
{
    private static readonly Dictionary<uint, string> FNV1aHashes = new();
    private static readonly Dictionary<ulong, string> XXH64Hashes = new();
    private static bool _loaded = false;
    private static readonly object _lock = new();
    private static Task? _loadingTask = null;

    public static void Load(string hashDir)
    {
        if (_loaded) return;

        lock (_lock)
        {
            if (_loaded) return;

            if (!Directory.Exists(hashDir)) return;

            // Check for binary hash files first (much faster)
            var binFiles = Directory.GetFiles(hashDir, "*.bin");
            if (binFiles.Length > 0)
            {
                try 
                {
                    foreach (var file in binFiles)
                    {
                        LoadBinary(file);
                    }
                    _loaded = true;
                    Logger.Info("Loaded hashes from binary files (fast load)");
                    return;
                }
                catch (Exception ex)
                {
                    Logger.Error("Failed to load binary hashes, falling back to text", ex);
                    // Fall back to text loading if binary fails
                    FNV1aHashes.Clear();
                    XXH64Hashes.Clear();
                }
            }

            var files = Directory.GetFiles(hashDir, "*.txt");
            foreach (var file in files)
            {
                // Use ReadLines instead of ReadAllLines to avoid loading entire file into memory
                // ReadLines is lazy - only loads one line at a time
                foreach (var line in File.ReadLines(file))
                {
                    if (string.IsNullOrWhiteSpace(line)) continue;

                    var spaceIndex = line.IndexOf(' ');
                    if (spaceIndex <= 0 || spaceIndex >= line.Length - 1) continue;

                    var hashStr = line.AsSpan(0, spaceIndex);
                    var value = line.Substring(spaceIndex + 1);

                    if (hashStr.Length == 16)
                    {
                        if (ulong.TryParse(hashStr, System.Globalization.NumberStyles.HexNumber, null, out var hash64))
                        {
                            XXH64Hashes[hash64] = value;
                        }
                    }
                    else if (hashStr.Length == 8)
                    {
                        if (uint.TryParse(hashStr, System.Globalization.NumberStyles.HexNumber, null, out var hash32))
                        {
                            FNV1aHashes[hash32] = value;
                        }
                    }
                }
            }

            _loaded = true;
        }
    }

    private static void LoadBinary(string binaryFile)
    {
        using var fs = File.OpenRead(binaryFile);
        using var reader = new BinaryReader(fs);

        // Read header
        var magic = new string(reader.ReadChars(4));
        if (magic != "HHSH") throw new Exception("Invalid binary hash file magic");

        var version = reader.ReadInt32();
        if (version != 1) throw new Exception($"Unsupported binary hash version: {version}");

        var fnv1aCount = reader.ReadInt32();
        var xxh64Count = reader.ReadInt32();

        // Pre-allocate or resize dictionaries
        if (FNV1aHashes.Count == 0)
            FNV1aHashes.EnsureCapacity(fnv1aCount);
        
        if (XXH64Hashes.Count == 0)
            XXH64Hashes.EnsureCapacity(xxh64Count);

        // Read FNV1a entries
        for (int i = 0; i < fnv1aCount; i++)
        {
            var hash = reader.ReadUInt32();
            var value = reader.ReadString();
            FNV1aHashes[hash] = value;
        }

        // Read XXH64 entries
        for (int i = 0; i < xxh64Count; i++)
        {
            var hash = reader.ReadUInt64();
            var value = reader.ReadString();
            XXH64Hashes[hash] = value;
        }
    }

    // Async version for preloading without blocking
    public static Task LoadAsync(string hashDir)
    {
        if (_loaded) return Task.CompletedTask;

        lock (_lock)
        {
            if (_loaded) return Task.CompletedTask;
            if (_loadingTask != null) return _loadingTask;

            _loadingTask = Task.Run(() => Load(hashDir));
            return _loadingTask;
        }
    }

    // Unload hashes to free memory
    public static void Unload()
    {
        lock (_lock)
        {
            FNV1aHashes.Clear();
            XXH64Hashes.Clear();
            
            // Trim excess capacity to release backing arrays
            FNV1aHashes.TrimExcess();
            XXH64Hashes.TrimExcess();
            
            _loaded = false;
            _loadingTask = null;
            
            // Aggressive garbage collection to free memory
            GCSettings.LargeObjectHeapCompactionMode = GCLargeObjectHeapCompactionMode.CompactOnce;
            GC.Collect(GC.MaxGeneration, GCCollectionMode.Aggressive, blocking: true, compacting: true);
            GC.WaitForPendingFinalizers();
            GC.Collect(GC.MaxGeneration, GCCollectionMode.Aggressive, blocking: true, compacting: true);
        }
    }

    public static bool IsLoaded => _loaded;

    public static string? GetFNV1a(uint hash)
    {
        return FNV1aHashes.TryGetValue(hash, out var val) ? val : null;
    }

    public static string? GetXXH64(ulong hash)
    {
        return XXH64Hashes.TryGetValue(hash, out var val) ? val : null;
    }
}
