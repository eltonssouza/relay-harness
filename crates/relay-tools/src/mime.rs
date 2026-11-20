//! The image types `read` attaches, by their first bytes (`detectSupportedImageMimeType` in
//! `utils/mime.ts`): JPEG (not JPEG-LS), PNG (not animated), GIF, WebP and BMP.

use std::fs::File;
use std::io::Read;
use std::path::Path;

const SNIFF_BYTES: usize = 4100;
const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

fn byte(buffer: &[u8], offset: usize) -> u32 {
    buffer.get(offset).copied().unwrap_or(0).into()
}

fn u16_le(buffer: &[u8], offset: usize) -> u32 {
    byte(buffer, offset) | (byte(buffer, offset + 1) << 8)
}

fn u32_be(buffer: &[u8], offset: usize) -> u64 {
    (u64::from(byte(buffer, offset)) << 24)
        | (u64::from(byte(buffer, offset + 1)) << 16)
        | (u64::from(byte(buffer, offset + 2)) << 8)
        | u64::from(byte(buffer, offset + 3))
}

fn u32_le(buffer: &[u8], offset: usize) -> u64 {
    u64::from(byte(buffer, offset))
        | (u64::from(byte(buffer, offset + 1)) << 8)
        | (u64::from(byte(buffer, offset + 2)) << 16)
        | (u64::from(byte(buffer, offset + 3)) << 24)
}

fn ascii_at(buffer: &[u8], offset: usize, text: &str) -> bool {
    buffer.get(offset..offset + text.len()) == Some(text.as_bytes())
}

fn is_png(buffer: &[u8]) -> bool {
    buffer.len() >= 16 && u32_be(buffer, PNG_SIGNATURE.len()) == 13 && ascii_at(buffer, 12, "IHDR")
}

fn is_animated_png(buffer: &[u8]) -> bool {
    let mut offset = PNG_SIGNATURE.len();
    while offset + 8 <= buffer.len() {
        let length = u32_be(buffer, offset);
        if ascii_at(buffer, offset + 4, "acTL") {
            return true;
        }
        if ascii_at(buffer, offset + 4, "IDAT") {
            return false;
        }
        let next = offset as u64 + 8 + length + 4;
        if next <= offset as u64 || next > buffer.len() as u64 {
            return false;
        }
        offset = next as usize;
    }
    false
}

fn is_bmp(buffer: &[u8]) -> bool {
    if buffer.len() < 26 {
        return false;
    }
    let declared_size = u32_le(buffer, 2);
    let pixel_offset = u32_le(buffer, 10);
    let header_size = u32_le(buffer, 14);
    if declared_size != 0 && declared_size < 26 {
        return false;
    }
    if pixel_offset < 14 + header_size {
        return false;
    }
    if declared_size != 0 && pixel_offset >= declared_size {
        return false;
    }
    let (planes, bits) = if header_size == 12 {
        (u16_le(buffer, 22), u16_le(buffer, 24))
    } else if (40..=124).contains(&header_size) {
        if buffer.len() < 30 {
            return false;
        }
        (u16_le(buffer, 26), u16_le(buffer, 28))
    } else {
        return false;
    };
    planes == 1 && [1, 4, 8, 16, 24, 32].contains(&bits)
}

/// The image type of these leading bytes, if `read` attaches it.
pub fn detect_supported_image_mime_type(buffer: &[u8]) -> Option<&'static str> {
    if buffer.starts_with(&[0xff, 0xd8, 0xff]) {
        return (buffer.get(3) != Some(&0xf7)).then_some("image/jpeg");
    }
    if buffer.starts_with(&PNG_SIGNATURE) {
        return (is_png(buffer) && !is_animated_png(buffer)).then_some("image/png");
    }
    if ascii_at(buffer, 0, "GIF87a") || ascii_at(buffer, 0, "GIF89a") {
        return Some("image/gif");
    }
    if ascii_at(buffer, 0, "RIFF") && ascii_at(buffer, 8, "WEBP") {
        return Some("image/webp");
    }
    if ascii_at(buffer, 0, "BM") && is_bmp(buffer) {
        return Some("image/bmp");
    }
    None
}

/// The image type of a file, from its first 4100 bytes.
pub fn detect_supported_image_mime_type_from_file(
    path: &Path,
) -> std::io::Result<Option<&'static str>> {
    let mut file = File::open(path)?;
    let mut buffer = vec![0; SNIFF_BYTES];
    let mut read = 0;
    while read < SNIFF_BYTES {
        match file.read(&mut buffer[read..])? {
            0 => break,
            count => read += count,
        }
    }
    Ok(detect_supported_image_mime_type(&buffer[..read]))
}
