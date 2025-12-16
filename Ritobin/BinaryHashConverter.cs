using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Globalization;
using Jade.Services;

namespace Jade.Ritobin;

public static class BinaryHashConverter
{
    private const string MAGIC = "HHSH";
    private const int VERSION = 1;

    public static void ConvertTextToBinary(string textFile, string binaryFile)
    {
        try
        {
            var fnv1a = new List<(uint hash, string value)>();
            var xxh64 = new List<(ulong hash, string value)>();
            
            // Parse text file
            foreach (var line in File.ReadLines(textFile))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;

                var spaceIndex = line.IndexOf(' ');
                if (spaceIndex <= 0 || spaceIndex >= line.Length - 1) continue;

                var hashStr = line.AsSpan(0, spaceIndex);
                var value = line.Substring(spaceIndex + 1);

                if (hashStr.Length == 16)
                {
                    if (ulong.TryParse(hashStr, NumberStyles.HexNumber, null, out var hash64))
                    {
                        xxh64.Add((hash64, value));
                    }
                }
                else if (hashStr.Length == 8)
                {
                    if (uint.TryParse(hashStr, NumberStyles.HexNumber, null, out var hash32))
                    {
                        fnv1a.Add((hash32, value));
                    }
                }
            }

            using var fs = File.Create(binaryFile);
            using var writer = new BinaryWriter(fs);
            
            // Write header
            writer.Write(Encoding.ASCII.GetBytes(MAGIC)); // Magic bytes
            writer.Write(VERSION); // Version
            
            // Write counts
            writer.Write(fnv1a.Count);
            writer.Write(xxh64.Count);
            
            // Write FNV1a entries
            foreach (var (hash, value) in fnv1a)
            {
                writer.Write(hash);
                writer.Write(value); // BinaryWriter handles string length prefix automatically
            }
            
            // Write XXH64 entries
            foreach (var (hash, value) in xxh64)
            {
                writer.Write(hash);
                writer.Write(value);
            }
            
            Logger.Info($"Converted {textFile} to binary: {fnv1a.Count} FNV1a, {xxh64.Count} XXH64 hashes");
        }
        catch (Exception ex)
        {
            Logger.Error($"Failed to convert {textFile} to binary", ex);
            throw;
        }
    }

    public static bool ValidateBinaryFile(string binaryFile)
    {
        try
        {
            if (!File.Exists(binaryFile)) return false;

            using var fs = File.OpenRead(binaryFile);
            using var reader = new BinaryReader(fs);

            if (fs.Length < 12) return false; // Too small for header

            var magic = Encoding.ASCII.GetString(reader.ReadBytes(4));
            if (magic != MAGIC) return false;

            var version = reader.ReadInt32();
            if (version != VERSION) return false;

            return true;
        }
        catch
        {
            return false;
        }
    }
}
