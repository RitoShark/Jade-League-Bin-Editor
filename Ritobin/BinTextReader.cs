using System;
using System.Collections.Generic;
using System.Globalization;
using System.Numerics;
using System.Text;

namespace Jade.Ritobin;

public class BinTextReader
{
    private readonly string _text;
    private int _position;
    private readonly List<(string Message, int Position)> _errors = new();
    private const int MaxErrors = 20; // Stop collecting after this many errors

    public BinTextReader(string text)
    {
        _text = text;
        _position = 0;
    }
    
    public IReadOnlyList<(string Message, int Position)> Errors => _errors;

    public Bin? ReadBin()
    {
        var bin = new Bin();
        SkipWhitespaceAndComments();
        
        while (!IsEof())
        {
            if (!ReadSection(bin))
            {
                return null;
            }
            if (!IsEof())
            {
                SkipWhitespaceAndComments();
            }
        }
        
        return bin;
    }
    
    /// <summary>
    /// Validates the entire file and collects all errors without stopping on first error.
    /// Used for error reporting in the editor.
    /// </summary>
    public void ValidateAll()
    {
        var bin = new Bin();
        SkipWhitespaceAndComments();
        
        while (!IsEof() && _errors.Count < MaxErrors)
        {
            var positionBeforeRead = _position;
            
            // Try to read section, but continue even if it fails
            try
            {
                ReadSection(bin);
            }
            catch
            {
                // Continue parsing even if section fails
            }
            
            // If we hit error limit, stop
            if (_errors.Count >= MaxErrors) break;
            
            // Try to skip to next section
            if (!IsEof())
            {
                SkipWhitespaceAndComments();
                
                // If we're stuck at the same position, skip ahead to avoid infinite loop
                if (_position == positionBeforeRead && !IsEof())
                {
                    // Skip to next line that looks like a section start (word followed by colon)
                    SkipToNextValidLine();
                }
            }
        }
    }
    
    /// <summary>
    /// Skips to the next line that looks like it could be valid syntax.
    /// </summary>
    private void SkipToNextValidLine()
    {
        // Skip current line
        while (!IsEof() && Peek() != '\n')
            Read();
        if (!IsEof())
            Read(); // Skip the newline
        
        // Skip any blank lines or comments
        SkipWhitespaceAndComments();
    }

    public string GetErrors()
    {
        if (_errors.Count == 0) return string.Empty;
        
        var sb = new StringBuilder();
        sb.AppendLine("Parse errors:");
        foreach (var (message, position) in _errors)
        {
            var (line, column) = GetLineColumn(position);
            sb.AppendLine($"  {message} at line {line}, column {column}");
        }
        return sb.ToString();
    }

    public (int Line, int Column) GetLineColumn(int position)
    {
        int line = 1, column = 1;
        for (int i = 0; i < position && i < _text.Length; i++)
        {
            if (_text[i] == '\n')
            {
                line++;
                column = 1;
            }
            else
            {
                column++;
            }
        }
        return (line,column);
    }

    private bool IsEof() => _position >= _text.Length;
    private char Peek(int offset = 0) => _position + offset >= _text.Length ? '\0' : _text[_position + offset];
    private char Read() => IsEof() ? '\0' : _text[_position++];

    // Like ritobin's next_newline - skips whitespace/comments and returns true if newline found
    private bool NextNewline()
    {
        bool inComment = false;
        bool foundNewline = false;
        
        while (!IsEof())
        {
            char c = Peek();
            if (c == '#')
            {
                inComment = true;
                Read();
            }
            else if (c == '\n')
            {
                inComment = false;
                foundNewline = true;
                Read();
            }
            else if (inComment || c == ' ' || c == '\t' || c == '\r')
            {
                Read();
            }
            else
            {
                break;
            }
        }
        
        return foundNewline;
    }

    private void SkipWhitespaceAndComments()
    {
        bool inComment = false;
        while (!IsEof())
        {
            char c = Peek();
            if (c == '#')
            {
                inComment = true;
                Read();
            }
            else if (c == '\n')
            {
                inComment = false;
                Read();
            }
            else if (inComment || c == ' ' || c == '\t' || c == '\r')
            {
                Read();
            }
            else
            {
                break;
            }
        }
    }

    private bool ReadSymbol(char symbol)
    {
        SkipWhitespace();
        if (Peek() == symbol)
        {
            Read();
            return true;
        }
        return false;
    }

    private bool ExpectSymbol(char symbol)
    {
        if (ReadSymbol(symbol))
        {
            return true;
        }
        AddError($"Expected '{symbol}'");
        return false;
    }

    private void SkipWhitespace()
    {
        while (!IsEof() && (Peek() == ' ' || Peek() == '\t' || Peek() == '\r'))
        {
            Read();
        }
    }
    
    // Like ritobin's read_nested_separator - returns true if newline or comma found
    private bool ReadNestedSeparator()
    {
        // Try newline first
        if (NextNewline())
        {
            return true;
        }
        
        // Try comma followed by optional newline
        if (ReadSymbol(','))
        {
            NextNewline();
            return true;
        }
        
        return false;
    }
    
    // Like ritobin's read_nested_separator_or_end - checks for } or separator, sets end flag
    private bool ReadNestedSeparatorOrEnd(out bool end)
    {
        end = false;
        
        // Check for closing brace
        if (ReadSymbol('}'))
        {
            end = true;
            return true;
        }
        
        // Check for separator
        if (ReadNestedSeparator())
        {
            // After separator, check again for closing brace
            end = ReadSymbol('}');
            return true;
        }
        
        return false;
    }

    private void AddError(string message)
    {
        _errors.Add((message, _position));
    }

    private string ReadWord()
    {
        SkipWhitespace();
        var start = _position;
        while (!IsEof())
        {
            char c = Peek();
            if (char.IsLetterOrDigit(c) || c == '_' || c == '+' || c == '-' || c == '.')
            {
                Read();
            }
            else
            {
                break;
            }
        }
        return _text.Substring(start, _position - start);
    }

    private bool ReadSection(Bin bin)
    {
        var name = ReadWord();
        if (string.IsNullOrEmpty(name))
        {
            AddError("Expected section name");
            return false;
        }

        if (!ExpectSymbol(':')) return false;

        var (valueType, listType, mapKeyType, mapValueType) = ReadTypeAnnotation();
        if (valueType == null)
        {
            return false;
        }

        if (!ExpectSymbol('=')) return false;

        var value = ReadValueOfType(valueType.Value, listType, mapKeyType, mapValueType);
        if (value == null) return false;

        bin.Sections[name] = value;
        SkipWhitespaceAndComments();
        
        return true;
    }

    private (BinType?, BinType?, BinType?, BinType?) ReadTypeAnnotation()
    {
        var typeName = ReadWord();
        if (string.IsNullOrEmpty(typeName))
        {
            AddError("Expected type name");
            return (null, null, null, null);
        }

        var lowerType = typeName.ToLowerInvariant();
        
        // Handle list[type] or list2[type]
        if (lowerType == "list" || lowerType == "list2")
        {
            if (!ExpectSymbol('[')) return (null, null, null, null);
            var elementTypeName = ReadWord();
            if (!ExpectSymbol(']')) return (null, null, null, null);
            
            var elementType = ParseTypeName(elementTypeName);
            if (elementType == null)
            {
                AddError($"Unknown element type: {elementTypeName}");
                return (null, null, null, null);
            }
            
            return (lowerType == "list" ? BinType.List : BinType.List2, elementType.Value, null, null);
        }
        
        // Handle option[type]
        if (lowerType == "option")
        {
            if (!ExpectSymbol('[')) return (null, null, null, null);
            var optionTypeName = ReadWord();
            if (!ExpectSymbol(']')) return (null, null, null, null);
            
            var optionType = ParseTypeName(optionTypeName);
            if (optionType == null)
            {
                AddError($"Unknown option type: {optionTypeName}");
                return (null, null, null, null);
            }
            
            return (BinType.Option, optionType.Value, null, null);
        }
        
        // Handle map[keyType, valueType]
        if (lowerType == "map")
        {
            if (!ExpectSymbol('[')) return (null, null, null, null);
            var keyTypeName = ReadWord();
            if (!ExpectSymbol(',')) return (null, null, null, null);
            var valueTypeName = ReadWord();
            if (!ExpectSymbol(']')) return (null, null, null, null);
            
            var keyType = ParseTypeName(keyTypeName);
            var valueType = ParseTypeName(valueTypeName);
            
            if (keyType == null)
            {
                AddError($"Unknown map key type: {keyTypeName}");
                return (null, null, null, null);
            }
            if (valueType == null)
            {
                AddError($"Unknown map value type: {valueTypeName}");
                return (null, null, null, null);
            }
            
            return (BinType.Map, null, keyType.Value, valueType.Value);
        }

        var type = ParseTypeName(typeName);
        if (type == null)
        {
            AddError($"Unknown type: {typeName}");
            return (null, null, null, null);
        }
        
        return (type.Value, null, null, null);
    }

    private BinType? ParseTypeName(string name)
    {
        return name.ToLowerInvariant() switch
        {
            "none" => BinType.None,
            "bool" => BinType.Bool,
            "i8" => BinType.I8,
            "u8" => BinType.U8,
            "i16" => BinType.I16,
            "u16" => BinType.U16,
            "i32" => BinType.I32,
            "u32" => BinType.U32,
            "i64" => BinType.I64,
            "u64" => BinType.U64,
            "f32" => BinType.F32,
            "vec2" => BinType.Vec2,
            "vec3" => BinType.Vec3,
            "vec4" => BinType.Vec4,
            "mtx44" => BinType.Mtx44,
            "rgba" => BinType.Rgba,
            "string" => BinType.String,
            "hash" => BinType.Hash,
            "file" => BinType.File,
            "link" => BinType.Link,
            "pointer" => BinType.Pointer,
            "embed" => BinType.Embed,
            "flag" => BinType.Flag,
            _ => null
        };
    }

    private BinValue? ReadValueOfType(BinType type, BinType? listType = null, BinType? mapKeyType = null, BinType? mapValueType = null)
    {
        switch (type)
        {
            case BinType.None:
                return ReadNone();
            case BinType.Bool:
                return ReadBool();
            case BinType.Flag:
                return ReadFlag();
            case BinType.I8:
                return ReadI8();
            case BinType.U8:
                return ReadU8();
            case BinType.I16:
                return ReadI16();
            case BinType.U16:
                return ReadU16();
            case BinType.I32:
                return ReadI32();
            case BinType.U32:
                return ReadU32();
            case BinType.I64:
                return ReadI64();
            case BinType.U64:
                return ReadU64();
            case BinType.F32:
                return ReadF32();
            case BinType.Vec2:
                return ReadVec2();
            case BinType.Vec3:
                return ReadVec3();
            case BinType.Vec4:
                return ReadVec4();
            case BinType.Mtx44:
                return ReadMtx44();
            case BinType.Rgba:
                return ReadRgba();
            case BinType.String:
                return ReadStringValue();
            case BinType.Hash:
                return ReadHash();
            case BinType.File:
                return ReadFile();
            case BinType.Link:
                return ReadLink();
            case BinType.Pointer:
                return ReadPointer();
            case BinType.Embed:
                return ReadEmbed();
            case BinType.List:
                return ReadList(listType ?? BinType.None);
            case BinType.List2:
                return ReadList2(listType ?? BinType.None);
            case BinType.Option:
                return ReadOption(listType ?? BinType.None);
            case BinType.Map:
                return ReadMap(mapKeyType ?? BinType.None, mapValueType ?? BinType.None);
            default:
                AddError($"Unknown type: {type}");
                return null;
        }
    }

    private BinNone ReadNone()
    {
        var word = ReadWord();
        if (word != "null")
        {
            AddError($"Expected 'null for none type, got '{word}'");
        }
        return new BinNone();
    }

    private BinBool? ReadBool()
    {
        var word = ReadWord();
        if (word == "true") return new BinBool(true);
        if (word == "false") return new BinBool(false);
        AddError($"Expected 'true' or 'false', got '{word}'");
        return null;
    }

    private BinFlag? ReadFlag()
    {
        var word = ReadWord();
        if (word == "true") return new BinFlag(true);
        if (word == "false") return new BinFlag(false);
        AddError($"Expected 'true' or 'false', got '{word}'");
        return null;
    }

    private BinValue? ReadNumber<T>(Func<T, BinValue> constructor) where T : struct
    {
        SkipWhitespace();
        
        // Check what we're about to read
        if (IsEof())
        {
            AddError($"Expected {typeof(T).Name} value but reached end of file");
            return null;
        }
        
        char nextChar = Peek();
        
        // If next char isn't a valid number start, report what we found
        if (!char.IsDigit(nextChar) && nextChar != '-' && nextChar != '+' && nextChar != '.')
        {
            AddError($"Expected number but found '{nextChar}' - check for missing value or extra comma");
            return null;
        }
        
        var word = ReadWord();
        
        if (string.IsNullOrEmpty(word))
        {
            AddError($"Expected {typeof(T).Name} value but found nothing");
            return null;
        }
        
        try
        {
            T value;
            if (typeof(T) == typeof(sbyte))
                value = (T)(object)sbyte.Parse(word);
            else if (typeof(T) == typeof(byte))
                value = (T)(object)byte.Parse(word);
            else if (typeof(T) == typeof(short))
                value = (T)(object)short.Parse(word);
            else if (typeof(T) == typeof(ushort))
                value = (T)(object)ushort.Parse(word);
            else if (typeof(T) == typeof(int))
                value = (T)(object)int.Parse(word);
            else if (typeof(T) == typeof(uint))
                value = (T)(object)uint.Parse(word);
            else if (typeof(T) == typeof(long))
                value = (T)(object)long.Parse(word);
            else if (typeof(T) == typeof(ulong))
                value = (T)(object)ulong.Parse(word);
            else if (typeof(T) == typeof(float))
                value = (T)(object)float.Parse(word, CultureInfo.InvariantCulture);
            else
                throw new NotSupportedException($"Type {typeof(T)} not supported");
            
            return constructor(value);
        }
        catch
        {
            AddError($"'{word}' is not a valid {typeof(T).Name} number");
            return null;
        }
    }

    private BinI8? ReadI8() => (BinI8?)ReadNumber<sbyte>(v => new BinI8(v));
    private BinU8? ReadU8() => (BinU8?)ReadNumber<byte>(v => new BinU8(v));
    private BinI16? ReadI16() => (BinI16?)ReadNumber<short>(v => new BinI16(v));
    private BinU16? ReadU16() => (BinU16?)ReadNumber<ushort>(v => new BinU16(v));
    private BinI32? ReadI32() => (BinI32?)ReadNumber<int>(v => new BinI32(v));
    private BinU32? ReadU32() => (BinU32?)ReadNumber<uint>(v => new BinU32(v));
    private BinI64? ReadI64() => (BinI64?)ReadNumber<long>(v => new BinI64(v));
    private BinU64? ReadU64() => (BinU64?)ReadNumber<ulong>(v => new BinU64(v));
    private BinF32? ReadF32() => (BinF32?)ReadNumber<float>(v => new BinF32(v));

    private BinString? ReadStringValue()
    {
        var str = ReadString();
        return str != null ? new BinString(str) : null;
    }

    private string? ReadString()
    {
        SkipWhitespace();
        if (Peek() != '"' && Peek() != '\'')
        {
            AddError("Expected string (starting with \" or ')");
            return null;
        }

        char quote = Read();
        var sb = new StringBuilder();
        bool escape = false;

        while (!IsEof())
        {
            char c = Read();
            if (escape)
            {
                switch (c)
                {
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case '\\': sb.Append('\\'); break;
                    case '"': sb.Append('"'); break;
                    case '\'': sb.Append('\''); break;
                    default: sb.Append(c); break;
                }
                escape = false;
            }
            else if (c == '\\')
            {
                escape = true;
            }
            else if (c == quote)
            {
                return sb.ToString();
            }
            else
            {
                sb.Append(c);
            }
        }

        AddError("Unterminated string");
        return null;
    }

    private FNV1a ReadHashOrString()
    {
        SkipWhitespace();
        if (Peek() == '"' || Peek() == '\'')
        {
            var str = ReadString();
            return str != null ? new FNV1a(str) : new FNV1a(0);
        }
        
        // Try hex hash
        var word = ReadWord();
        if (word.StartsWith("0x", StringComparison.OrdinalIgnoreCase) && word.Length > 2)
        {
            try
            {
                var hash = uint.Parse(word.Substring(2), NumberStyles.HexNumber);
                return new FNV1a(hash);
            }
            catch
            {
                AddError($"Failed to parse hash '{word}'");
                return new FNV1a(0);
            }
        }
        
        // Treat as name
        return new FNV1a(word);
    }

    private XXH64 ReadFileHashOrString()
    {
        SkipWhitespace();
        if (Peek() == '"' || Peek() == '\'')
        {
            var str = ReadString();
            if (str != null)
            {
                // Store string, BinHasher will compute hash later
                return new XXH64(0, str);
            }
            return new XXH64(0);
        }
        
        // Try hex hash
        var word = ReadWord();
        if (word.StartsWith("0x", StringComparison.OrdinalIgnoreCase) && word.Length > 2)
        {
            try
            {
                var hash = ulong.Parse(word.Substring(2), NumberStyles.HexNumber);
                return new XXH64(hash);
            }
            catch
            {
                AddError($"Failed to parse file hash '{word}'");
                return new XXH64(0);
            }
        }
        
        // Treat as name - store as string
        return new XXH64(0, word);
    }

    private BinHash? ReadHash() => new BinHash(ReadHashOrString());
    private BinFile? ReadFile() => new BinFile(ReadFileHashOrString());
    private BinLink? ReadLink() => new BinLink(ReadHashOrString());

    private BinPointer? ReadPointer()
    {
        var name = ReadHashOrString();
        
        // Check for null pointer
        if (name.String == "null")
        {
            return new BinPointer(new FNV1a(0));
        }
        
        var pointer = new BinPointer(name);
        
        // Read fields in braces - like ritobin's read_nested_begin
        if (!ExpectSymbol('{')) return null;
        NextNewline(); // Skip to next line after opening brace
        
        bool end = ReadSymbol('}'); // Check if immediately closed
        
        while (!end)
        {
            var field = ReadField();
            if (field == null) return null;
            pointer.Items.Add(field);
            
            if (!ReadNestedSeparatorOrEnd(out end)) return null;
        }
        
        return pointer;
    }

    private BinEmbed? ReadEmbed()
    {
        var name = ReadHashOrString();
        var embed = new BinEmbed(name);
        
        // Read fields in braces
        if (!ExpectSymbol('{')) return null;
        NextNewline();
        
        bool end = ReadSymbol('}');
        
        while (!end)
        {
            var field = ReadField();
            if (field == null) return null;
            embed.Items.Add(field);
            
            if (!ReadNestedSeparatorOrEnd(out end)) return null;
        }
        
        return embed;
    }

    private BinField? ReadField()
    {
        var fieldName = ReadHashOrString();
        
        if (!ExpectSymbol(':')) return null;
        var (type, listType, mapKeyType, mapValueType) = ReadTypeAnnotation();
        if (type == null) return null;
        
        if (!ExpectSymbol('=')) return null;
        var value = ReadValueOfType(type.Value, listType, mapKeyType, mapValueType);
        if (value == null) return null;
        
        return new BinField(fieldName, value);
    }

    private BinList? ReadList(BinType elementType)
    {
        var list = new BinList(elementType);
        
        if (!ExpectSymbol('{')) return null;
        NextNewline();
        
        bool end = ReadSymbol('}');
        
        while (!end)
        {
            var value = ReadValueOfType(elementType);
            if (value == null) return null;
            list.Items.Add(value);
            
            if (!ReadNestedSeparatorOrEnd(out end))
            {
                AddError("Expected separator (newline/comma) or closing brace '}'");
                return null;
            }
        }
        
        return list;
    }

    private BinList2? ReadList2(BinType elementType)
    {
        var list = new BinList2(elementType);
        
        if (!ExpectSymbol('{')) return null;
        NextNewline();
        
        bool end = ReadSymbol('}');
        
        while (!end)
        {
            var value = ReadValueOfType(elementType);
            if (value == null) return null;
            list.Items.Add(value);
            
            if (!ReadNestedSeparatorOrEnd(out end))
            {
                AddError("Expected separator (newline/comma) or closing brace '}'");
                return null;
            }
        }
        
        return list;
    }

    private BinOption? ReadOption(BinType valueType)
    {
        var option = new BinOption(valueType);
        
        if (!ExpectSymbol('{')) return null;
        NextNewline();
        
        bool end = ReadSymbol('}');
        
        if (!end)
        {
            var value = ReadValueOfType(valueType);
            if (value == null) return null;
            option.Items.Add(value);
            
            if (!ReadNestedSeparatorOrEnd(out end))
            {
                AddError("Expected separator (newline/comma) or closing brace '}'");
                return null;
            }
            if (!end)
            {
                AddError("Option can only contain 0 or 1 elements");
                return null;
            }
        }
        
        return option;
    }

    private BinMap? ReadMap(BinType keyType, BinType valueType)
    {
        var map = new BinMap(keyType, valueType);
        
        if (!ExpectSymbol('{')) return null;
        NextNewline();
        
        bool end = ReadSymbol('}');
        
        while (!end)
        {
            var key = ReadValueOfType(keyType);
            if (key == null) return null;
            
            if (!ExpectSymbol('=')) return null;
            
            var value = ReadValueOfType(valueType);
            if (value == null) return null;
            
            map.Items.Add(new KeyValuePair<BinValue, BinValue>(key, value));
            
            if (!ReadNestedSeparatorOrEnd(out end))
            {
                AddError("Expected separator (newline/comma) or closing brace '}'");
                return null;
            }
        }
        
        return map;
    }

    private BinVec2? ReadVec2()
    {
        if (!ExpectSymbol('{')) return null;
        NextNewline();
        
        bool end = ReadSymbol('}');
        if (end)
        {
            AddError("Vec2 requires 2 values");
            return null;
        }
        
        var x = ReadF32();
        if (x == null) return null;
        
        if (!ReadNestedSeparatorOrEnd(out end))
        {
            AddError("Expected separator or closing brace");
            return null;
        }
        if (end)
        {
            AddError("Vec2 requires 2 values, only got 1");
            return null;
        }
        
        var y = ReadF32();
        if (y == null) return null;
        
        if (!ReadNestedSeparatorOrEnd(out end))
        {
            AddError("Expected closing brace");
            return null;
        }
        if (!end)
        {
            AddError("Vec2 can only have 2 values");
            return null;
        }
        
        return new BinVec2(new Vector2(x.Value, y.Value));
    }

    private BinVec3? ReadVec3()
    {
        if (!ExpectSymbol('{')) return null;
        NextNewline();
        
        bool end = ReadSymbol('}');
        if (end)
        {
            AddError("Vec3 requires 3 values");
            return null;
        }
        
        var x = ReadF32();
        if (x == null) return null;
        
        if (!ReadNestedSeparatorOrEnd(out end))
        {
            AddError("Expected separator");
            return null;
        }
        if (end)
        {
            AddError("Vec3 requires 3 values");
            return null;
        }
        
        var y = ReadF32();
        if (y == null) return null;
        
        if (!ReadNestedSeparatorOrEnd(out end))
        {
            AddError("Expected separator");
            return null;
        }
        if (end)
        {
            AddError("Vec3 requires 3 values");
            return null;
        }
        
        var z = ReadF32();
        if (z == null) return null;
        
        if (!ReadNestedSeparatorOrEnd(out end))
        {
            AddError("Expected closing brace");
            return null;
        }
        if (!end)
        {
            AddError("Vec3 can only have 3 values");
            return null;
        }
        
        return new BinVec3(new Vector3(x.Value, y.Value, z.Value));
    }

    private BinVec4? ReadVec4()
    {
        if (!ExpectSymbol('{')) return null;
        NextNewline();
        
        bool end = ReadSymbol('}');
        if (end)
        {
            AddError("Vec4 requires 4 values");
            return null;
        }
        
      var x = ReadF32();
        if (x == null) return null;
        
        if (!ReadNestedSeparatorOrEnd(out end))
        {
            AddError("Expected separator");
            return null;
        }
        if (end)
        {
            AddError("Vec4 requires 4 values");
            return null;
        }
        
        var y = ReadF32();
        if (y == null) return null;
        
        if (!ReadNestedSeparatorOrEnd(out end))
        {
            AddError("Expected separator");
            return null;
        }
        if (end)
        {
            AddError("Vec4 requires 4 values");
            return null;
        }
        
        var z = ReadF32();
        if (z == null) return null;
        
        if (!ReadNestedSeparatorOrEnd(out end))
        {
            AddError("Expected separator");
            return null;
        }
        if (end)
        {
            AddError("Vec4 requires 4 values");
            return null;
        }
        
        var w = ReadF32();
        if (w == null) return null;
        
        if (!ReadNestedSeparatorOrEnd(out end))
        {
            AddError("Expected closing brace");
            return null;
        }
        if (!end)
        {
            AddError("Vec4 can only have 4 values");
            return null;
        }
        
        return new BinVec4(new Vector4(x.Value, y.Value, z.Value, w.Value));
    }

    private BinMtx44? ReadMtx44()
    {
        if (!ExpectSymbol('{')) return null;
        NextNewline();
        
        bool end = ReadSymbol('}');
        if (end)
        {
            AddError("Mtx44 requires 16 values");
            return null;
        }
        
        var values = new float[16];
        for (int i = 0; i < 16; i++)
        {
            var val = ReadF32();
            if (val == null) return null;
            values[i] = val.Value;
            
            if (!ReadNestedSeparatorOrEnd(out end))
            {
                AddError("Expected separator or closing brace");
                return null;
            }
            
            if (i < 15 && end)
            {
                AddError($"Mtx44 requires 16 values, only got {i + 1}");
                return null;
            }
            if (i == 15 && !end)
            {
                AddError("Mtx44 can only have 16 values");
                return null;
            }
        }
        
        var mtx = new Matrix4x4(
            values[0], values[1], values[2], values[3],
            values[4], values[5], values[6], values[7],
            values[8], values[9], values[10], values[11],
            values[12], values[13], values[14], values[15]
        );
        return new BinMtx44(mtx);
    }

    private BinRgba? ReadRgba()
    {
        if (!ExpectSymbol('{')) return null;
        NextNewline();
        
        bool end = ReadSymbol('}');
        if (end)
        {
            AddError("RGBA requires 4 values");
            return null;
        }
        
        var r = ReadU8();
        if (r == null) return null;
        
        if (!ReadNestedSeparatorOrEnd(out end))
        {
            AddError("Expected separator");
            return null;
        }
        if (end)
        {
            AddError("RGBA requires 4 values");
            return null;
        }
        
        var g = ReadU8();
        if (g == null) return null;
        
        if (!ReadNestedSeparatorOrEnd(out end))
        {
            AddError("Expected separator");
            return null;
        }
        if (end)
        {
            AddError("RGBA requires 4 values");
            return null;
        }
        
        var b = ReadU8();
        if (b == null) return null;
        
        if (!ReadNestedSeparatorOrEnd(out end))
        {
            AddError("Expected separator");
            return null;
        }
        if (end)
        {
            AddError("RGBA requires 4 values");
            return null;
        }
        
        var a = ReadU8();
        if (a == null) return null;
        
        if (!ReadNestedSeparatorOrEnd(out end))
        {
            AddError("Expected closing brace");
            return null;
        }
        if (!end)
        {
            AddError("RGBA can only have 4 values");
            return null;
        }
        
        return new BinRgba(r.Value, g.Value, b.Value, a.Value);
    }
}
