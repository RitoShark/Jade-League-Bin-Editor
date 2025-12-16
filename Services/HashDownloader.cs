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
    
    private static readonly string[] GAME_HASH_PART_URLS = new[]
    {
        "https://raw.githubusercontent.com/CommunityDragon/Data/master/hashes/lol/hashes.game.txt.0",
        "https://raw.githubusercontent.com/CommunityDragon/Data/master/hashes/lol/hashes.game.txt.1"
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
        var required = HASH_FILES.Concat(new[] { "hashes.game.txt" }).ToList();
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
            var totalFiles = HASH_FILES.Length + 1; // +1 for game.txt
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
            
            // Download hashes.game.txt - try single file first, then split files
            currentFile++;
            progress?.Report(("Downloading hashes.game.txt...", currentFile, totalFiles));
            
            var gameHashPath = Path.Combine(hashDir, "hashes.game.txt");
            
            try
            {
                // Try downloading as a single file first
                var singleFileUrl = BASE_URL + "hashes.game.txt";
                try
                {
                    var singleResponse = await _httpClient.GetAsync(singleFileUrl);
                    if (singleResponse.IsSuccessStatusCode)
                    {
                        var content = await singleResponse.Content.ReadAsByteArrayAsync();
                        await File.WriteAllBytesAsync(gameHashPath, content);
                        downloaded.Add("hashes.game.txt");
                    }
                    else
                    {
                        throw new Exception("Single file not found, trying split files");
                    }
                }
                catch
                {
                    // If single file fails, try split files
                    progress?.Report(("Downloading hashes.game.txt (part 1/2)...", currentFile, totalFiles));
                    
                    var part0Response = await _httpClient.GetAsync(GAME_HASH_PART_URLS[0]);
                    part0Response.EnsureSuccessStatusCode();
                    var part0Data = await part0Response.Content.ReadAsByteArrayAsync();
                    
                    progress?.Report(("Downloading hashes.game.txt (part 2/2)...", currentFile, totalFiles));
                    
                    var part1Response = await _httpClient.GetAsync(GAME_HASH_PART_URLS[1]);
                    part1Response.EnsureSuccessStatusCode();
                    var part1Data = await part1Response.Content.ReadAsByteArrayAsync();
                    
                    // Combine parts
                    var combinedData = new byte[part0Data.Length + part1Data.Length];
                    Buffer.BlockCopy(part0Data, 0, combinedData, 0, part0Data.Length);
                    Buffer.BlockCopy(part1Data, 0, combinedData, part0Data.Length, part1Data.Length);
                    
                    await File.WriteAllBytesAsync(gameHashPath, combinedData);
                    downloaded.Add("hashes.game.txt");
                }
            }
            catch (Exception ex)
            {
                Logger.Error("Failed to download hashes.game.txt", ex);
                errors.Add($"hashes.game.txt: {ex.Message}");
            }
            
            // Check if binary format is enabled
            bool useBinaryFormat = false;
            try
            {
                var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
                var prefsFile = Path.Combine(appDataPath, "RitoShark", "Jade", "settings.txt");
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
