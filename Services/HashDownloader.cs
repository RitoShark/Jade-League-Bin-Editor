using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Threading.Tasks;

namespace Jade.Services;

public class HashDownloader
{
    private static readonly HttpClient _httpClient = new();
    
    private static readonly string[] HASH_FILES = new[]
    {
        "hashes.binentries.txt",
        "hashes.binfields.txt",
        "hashes.binhashes.txt",
        "hashes.bintypes.txt",
        "hashes.lcu.txt"
    };
    
    private const string BASE_URL = "https://raw.githubusercontent.com/CommunityDragon/Data/master/hashes/lol/";
    
    public static string GetHashDirectory()
    {
        var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var hashDir = Path.Combine(appDataPath, "RitoShark", "Jade", "hashes");
        
        if (!Directory.Exists(hashDir))
        {
            Directory.CreateDirectory(hashDir);
        }
        
        return hashDir;
    }
    
    public static (bool AllPresent, List<string> Missing, string Format) CheckHashes()
    {
        var hashDir = GetHashDirectory();
        var required = HASH_FILES.ToList();
        var missing = new List<string>();
        int txtCount = 0;
        int binCount = 0;
        
        foreach (var filename in required)
        {
            var txtPath = Path.Combine(hashDir, filename);
            var binPath = Path.ChangeExtension(txtPath, ".bin");
            
            if (File.Exists(binPath))
            {
                binCount++;
            }
            else if (File.Exists(txtPath))
            {
                txtCount++;
            }
            else
            {
                missing.Add(filename);
            }
        }
        
        string format = "None";
        if (binCount > 0 && txtCount == 0) format = "Binary";
        else if (txtCount > 0 && binCount == 0) format = "Text";
        else if (binCount > 0 && txtCount > 0) format = "Mixed";
        
        return (missing.Count == 0, missing, format);
    }
    
    public static async Task<(bool Success, List<string> Downloaded, List<string> Errors)> DownloadHashesAsync(
        IProgress<(string Message, int Current, int Total)>? progress = null)
    {
        var hashDir = GetHashDirectory();
        var downloaded = new List<string>();
        var errors = new List<string>();
        
        try
        {
            var totalFiles = HASH_FILES.Length;
            var currentFile = 0;
            
            // Download required hash files
            for (int i = 0; i < HASH_FILES.Length; i++)
            {
                var filename = HASH_FILES[i];
                var url = BASE_URL + filename;
                var filePath = Path.Combine(hashDir, filename);
                
                try
                {
                    currentFile++;
                    progress?.Report(($"Downloading {filename}...", currentFile, totalFiles));
                    
                    var response = await _httpClient.GetAsync(url);
                    response.EnsureSuccessStatusCode();
                    
                    var content = await response.Content.ReadAsByteArrayAsync();
                    await File.WriteAllBytesAsync(filePath, content);
                    
                    downloaded.Add(filename);
                }
                catch (Exception ex)
                {
                    Logger.Error($"Failed to download {filename}", ex);
                    errors.Add($"{filename}: {ex.Message}");
                }
            }
            
            // Check if binary format is enabled
            bool useBinaryFormat = false;
            try
            {
                var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
                var prefsFile = Path.Combine(appDataPath, "RitoShark", "Jade", "preferences.txt");
                if (File.Exists(prefsFile))
                {
                    var content = File.ReadAllText(prefsFile);
                    if (content.Contains("UseBinaryHashFormat=True"))
                    {
                        useBinaryFormat = true;
                    }
                }
            }
            catch { }

            if (useBinaryFormat)
            {
                progress?.Report(("Converting hashes to binary format...", currentFile, totalFiles));
                Logger.Info("Converting downloaded hashes to binary format");

                foreach (var file in downloaded.ToList())
                {
                    try
                    {
                        var txtPath = Path.Combine(hashDir, file);
                        var binPath = Path.ChangeExtension(txtPath, ".bin");
                        
                        Jade.Ritobin.BinaryHashConverter.ConvertTextToBinary(txtPath, binPath);
                        
                        // Verify conversion before deleting text file
                        if (Jade.Ritobin.BinaryHashConverter.ValidateBinaryFile(binPath))
                        {
                            File.Delete(txtPath);
                        }
                        else
                        {
                            Logger.Error($"Binary validation failed for {binPath}, keeping text file", null);
                            errors.Add($"Binary conversion failed for {file}");
                        }
                    }
                    catch (Exception ex)
                    {
                        Logger.Error($"Failed to convert {file} to binary", ex);
                        errors.Add($"Conversion failed for {file}: {ex.Message}");
                    }
                }
            }
            
            return (errors.Count == 0, downloaded, errors);
        }
        catch (Exception ex)
        {
            Logger.Error("General error downloading hashes", ex);
            return (false, downloaded, errors.Concat(new[] { $"General error: {ex.Message}" }).ToList());
        }
    }
}
