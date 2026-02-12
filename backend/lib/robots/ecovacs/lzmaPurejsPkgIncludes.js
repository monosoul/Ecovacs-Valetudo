/**
 * pkg doesn't resolve amdefine dependency arrays in lzma-purejs.
 * Keep explicit literal requires so all modules are bundled.
 */
require("lzma-purejs/lib/freeze");
require("lzma-purejs/lib/makeBuffer");
require("lzma-purejs/lib/Stream");
require("lzma-purejs/lib/LZ");
require("lzma-purejs/lib/LZ/BinTree");
require("lzma-purejs/lib/LZ/InWindow");
require("lzma-purejs/lib/LZ/OutWindow");
require("lzma-purejs/lib/LZMA");
require("lzma-purejs/lib/LZMA/Base");
require("lzma-purejs/lib/LZMA/Decoder");
require("lzma-purejs/lib/LZMA/Encoder");
require("lzma-purejs/lib/RangeCoder");
require("lzma-purejs/lib/RangeCoder/BitTreeDecoder");
require("lzma-purejs/lib/RangeCoder/BitTreeEncoder");
require("lzma-purejs/lib/RangeCoder/Decoder");
require("lzma-purejs/lib/RangeCoder/Encoder");
require("lzma-purejs/lib/Util");
