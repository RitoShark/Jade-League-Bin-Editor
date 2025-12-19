using System;
using System.Windows.Media;
using ICSharpCode.AvalonEdit.Highlighting;
using ICSharpCode.AvalonEdit.Highlighting.Xshd;
using System.Xml;

namespace Jade.Services;

public static class ThemeSyntaxHighlighting
{
    public static IHighlightingDefinition GetHighlightingForTheme(string theme)
    {
        var (keyword, comment, stringColor, number, propertyColor) = GetThemeColors(theme);
        
        var xshd = $@"<?xml version=""1.0""?>
<SyntaxDefinition name=""BinFile"" xmlns=""http://icsharpcode.net/sharpdevelop/syntaxdefinition/2008"">
    <Color name=""Comment"" foreground=""{comment}"" />
    <Color name=""String"" foreground=""{stringColor}"" />
    <Color name=""Keyword"" foreground=""{keyword}"" fontWeight=""bold"" />
    <Color name=""Number"" foreground=""{number}"" />
    <Color name=""Property"" foreground=""{propertyColor}"" />
    
    <RuleSet>
        <Span color=""Comment"" begin=""#"" />
        <Span color=""String"" multiline=""false"">
            <Begin>&quot;</Begin>
            <End>&quot;</End>
        </Span>
        
        <Rule color=""Property"">
            \b[\w\d_]+(?=\s*:)
        </Rule>
        
        <Keywords color=""Keyword"">
            <Word>string</Word>
            <Word>bool</Word>
            <Word>u8</Word>
            <Word>u16</Word>
            <Word>u32</Word>
            <Word>u64</Word>
            <Word>i8</Word>
            <Word>i16</Word>
            <Word>i32</Word>
            <Word>i64</Word>
            <Word>f32</Word>
            <Word>f64</Word>
            <Word>vec2</Word>
            <Word>vec3</Word>
            <Word>vec4</Word>
            <Word>list</Word>
            <Word>map</Word>
            <Word>option</Word>
            <Word>link</Word>
            <Word>embed</Word>
            <Word>hash</Word>
            <Word>flag</Word>
            <Word>pointer</Word>
            <Word>true</Word>
            <Word>false</Word>
            <Word>null</Word>
        </Keywords>
        
        <Rule color=""Number"">
            \b0[xX][0-9a-fA-F]+  # hex number
            |
            \b\d+\.?\d*([eE][+-]?\d+)?  # decimal number
        </Rule>
    </RuleSet>
</SyntaxDefinition>";

        using (var reader = new XmlTextReader(new System.IO.StringReader(xshd)))
        {
            return HighlightingLoader.Load(reader, HighlightingManager.Instance);
        }
    }
    
    private static (string keyword, string comment, string stringColor, string number, string propertyColor) GetThemeColors(string theme)
    {
        return theme switch
        {
            "DarkBlue" => ("#5DADE2", "#52BE80", "#F39C12", "#AED6F1", "#5DADE2"),
            "DarkRed" => ("#EC7063", "#82E0AA", "#F8C471", "#F1948A", "#EC7063"),
            "LightPink" => ("#7D3C98", "#1E8449", "#BA4A00", "#6C3483", "#7D3C98"),
            "PastelBlue" => ("#2874A6", "#117A65", "#D68910", "#1F618D", "#2874A6"),
            "ForestGreen" => ("#85C1E9", "#52BE80", "#F39C12", "#AED6F1", "#85C1E9"),
            "AMOLED" => ("#5DADE2", "#52BE80", "#F39C12", "#AED6F1", "#5DADE2"),
            "Void" => ("#BB8FCE", "#82E0AA", "#F8C471", "#D7BDE2", "#BB8FCE"),
            "VioletSorrow" => ("#9B7EDE", "#7EC8A3", "#E8A87C", "#C8A2E0", "#9B7EDE"),
            "HighContrast" => ("#FFFF00", "#00FF00", "#FF00FF", "#00FFFF", "#FFFF00"),
            "VSCode" => ("#569CD6", "#6A9955", "#CE9178", "#B5CEA8", "#9CDCFE"),
            _ => ("#569CD6", "#6A9955", "#CE9178", "#B5CEA8", "#569CD6") // Default VS Code colors
        };
    }
}
