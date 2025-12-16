using System;
using System.Collections.Generic;
using ICSharpCode.AvalonEdit.Document;
using ICSharpCode.AvalonEdit.Folding;

namespace Jade.Editor;

/// <summary>
/// Folding strategy for bin files - folds on braces { }
/// </summary>
public class BinFileFoldingStrategy
{
    public void UpdateFoldings(FoldingManager manager, TextDocument document)
    {
        int firstErrorOffset;
        var newFoldings = CreateNewFoldings(document, out firstErrorOffset);
        manager.UpdateFoldings(newFoldings, firstErrorOffset);
    }

    public IEnumerable<NewFolding> CreateNewFoldings(TextDocument document, out int firstErrorOffset)
    {
        firstErrorOffset = -1;
        return CreateNewFoldings(document);
    }

    public IEnumerable<NewFolding> CreateNewFoldings(TextDocument document)
    {
        var newFoldings = new List<NewFolding>();
        var startOffsets = new Stack<int>();
        var startLines = new Stack<int>();
        
        int offset = 0;
        int lineNumber = 1;
        
        while (offset < document.TextLength)
        {
            char c = document.GetCharAt(offset);
            
            if (c == '{')
            {
                startOffsets.Push(offset);
                startLines.Push(lineNumber);
            }
            else if (c == '}' && startOffsets.Count > 0)
            {
                int startOffset = startOffsets.Pop();
                int startLine = startLines.Pop();
                
                // Only create folding if it spans multiple lines
                if (lineNumber > startLine)
                {
                    // Get the text on the start line for the folding name
                    var startLineObj = document.GetLineByOffset(startOffset);
                    var lineText = document.GetText(startLineObj.Offset, Math.Min(50, startLineObj.Length));
                    
                    // Extract a meaningful name (e.g., the property name before the brace)
                    var name = ExtractFoldingName(lineText);
                    
                    newFoldings.Add(new NewFolding(startOffset, offset + 1)
                    {
                        Name = name,
                        DefaultClosed = false
                    });
                }
            }
            else if (c == '\n')
            {
                lineNumber++;
            }
            
            offset++;
        }
        
        newFoldings.Sort((a, b) => a.StartOffset.CompareTo(b.StartOffset));
        return newFoldings;
    }
    
    private string ExtractFoldingName(string lineText)
    {
        // Try to extract property name before the brace
        // Format is usually: "propertyName: type = {"
        var braceIndex = lineText.IndexOf('{');
        if (braceIndex > 0)
        {
            var beforeBrace = lineText.Substring(0, braceIndex).Trim();
            
            // Remove " = " if present
            if (beforeBrace.EndsWith(" ="))
                beforeBrace = beforeBrace.Substring(0, beforeBrace.Length - 2).Trim();
            
            // Extract just the property name (before the colon)
            var colonIndex = beforeBrace.IndexOf(':');
            if (colonIndex > 0)
            {
                var propertyName = beforeBrace.Substring(0, colonIndex).Trim();
                return propertyName + "...";
            }
            
            return beforeBrace + "...";
        }
        
        return "...";
    }
}
