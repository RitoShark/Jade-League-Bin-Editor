using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace Jade.Services;

/// <summary>
/// Parses linked bin file paths from bin file content.
/// </summary>
public static class LinkedBinParser
{
    /// <summary>
    /// Extracts linked bin file paths from the content of a bin file.
    /// Returns only the filenames (e.g., "AurelionSol.bin"), not full paths.
    /// </summary>
    public static List<string> ParseLinkedFiles(string content)
    {
        var linkedFiles = new List<string>();
        
        try
        {
            // Find the linked: list[string] = { ... } section
            // Pattern: linked: list[string] = { followed by quoted paths until closing }
            var linkedSectionPattern = @"linked:\s*list\[string\]\s*=\s*\{([^}]*)\}";
            var match = Regex.Match(content, linkedSectionPattern, RegexOptions.Singleline);
            
            if (match.Success)
            {
                var linkedContent = match.Groups[1].Value;
                
                // Extract all quoted paths (paths like "DATA/Characters/..." or just filenames)
                var pathPattern = @"""([^""]+\.bin)""";
                var pathMatches = Regex.Matches(linkedContent, pathPattern, RegexOptions.IgnoreCase);
                
                foreach (Match pathMatch in pathMatches)
                {
                    var fullPath = pathMatch.Groups[1].Value;
                    
                    // Extract just the filename from the path
                    var fileName = System.IO.Path.GetFileName(fullPath);
                    
                    if (!string.IsNullOrWhiteSpace(fileName) && !linkedFiles.Contains(fileName))
                    {
                        linkedFiles.Add(fileName);
                    }
                }
                
                Logger.Info($"LinkedBinParser: Found {linkedFiles.Count} linked bin files");
            }
        }
        catch (Exception ex)
        {
            Logger.Error("LinkedBinParser: Failed to parse linked files", ex);
        }
        
        return linkedFiles;
    }
    
    /// <summary>
    /// Searches for a bin file by name in the DATA folder hierarchy.
    /// Starts from the given base directory and searches recursively up to maxDepth.
    /// </summary>
    public static string? FindBinFileInDataFolder(string baseDirectory, string fileName, int maxDepth = 5)
    {
        try
        {
            // Look for DATA folder in the path hierarchy
            var currentDir = baseDirectory;
            string? dataFolder = null;
            
            // Walk up the directory tree to find DATA folder
            for (int i = 0; i < 10 && currentDir != null; i++)
            {
                var potentialDataFolder = System.IO.Path.Combine(currentDir, "DATA");
                if (System.IO.Directory.Exists(potentialDataFolder))
                {
                    dataFolder = potentialDataFolder;
                    break;
                }
                
                // Check if current folder IS the DATA folder
                if (System.IO.Path.GetFileName(currentDir).Equals("DATA", StringComparison.OrdinalIgnoreCase))
                {
                    dataFolder = currentDir;
                    break;
                }
                
                currentDir = System.IO.Path.GetDirectoryName(currentDir);
            }
            
            if (dataFolder == null)
            {
                // Fallback: use the base directory itself
                dataFolder = baseDirectory;
            }
            
            // Search for the file recursively in the DATA folder
            return SearchFileRecursively(dataFolder, fileName, 0, maxDepth);
        }
        catch (Exception ex)
        {
            Logger.Error($"LinkedBinParser: Error finding file {fileName}", ex);
            return null;
        }
    }
    
    private static string? SearchFileRecursively(string directory, string fileName, int currentDepth, int maxDepth)
    {
        if (currentDepth > maxDepth) return null;
        
        try
        {
            // Check for file in current directory
            var filePath = System.IO.Path.Combine(directory, fileName);
            if (System.IO.File.Exists(filePath))
            {
                return filePath;
            }
            
            // Search subdirectories
            foreach (var subDir in System.IO.Directory.GetDirectories(directory))
            {
                var result = SearchFileRecursively(subDir, fileName, currentDepth + 1, maxDepth);
                if (result != null)
                {
                    return result;
                }
            }
        }
        catch
        {
            // Skip directories we can't access
        }
        
        return null;
    }
}
