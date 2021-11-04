{
  "variables": {
    "simulate%": "false"
  },
  "targets": [
    {
      "target_name": "lora_comms",
      "sources": [ "src/lora_comms.cc" ],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")",
                       "./packet_forwarder_shared/lora_pkt_fwd/inc"],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      'cflags+': [ '-std=gnu++14', '-Wall', '-Wextra', '-Werror' ],
      'cflags!': [ '-fno-exceptions' ],
      'cflags_cc!': [ '-fno-exceptions', '-std=gnu++0x' ],
      'ldflags': [ '-L../packet_forwarder_shared/lora_pkt_fwd',
                   '-Wl,-rpath,\$$ORIGIN/../../packet_forwarder_shared/lora_pkt_fwd' ],
      'xcode_settings': {
        'GCC_ENABLE_CPP_EXCEPTIONS': 'YES',
        'CLANG_CXX_LIBRARY': 'libc++',
        'MACOSX_DEPLOYMENT_TARGET': '10.7',
        'CLANG_CXX_LANGUAGE_STANDARD': 'c++17',
        'WARNING_CFLAGS': [ '-Wall', '-Wextra' ],
        'GCC_TREAT_WARNINGS_AS_ERRORS': 'YES'
      },
      'msvs_settings': {
        'VCCLCompilerTool': { 'ExceptionHandling': 1 },
      },
      'conditions': [
        [
          'coverage == "true"',
          {
            'cflags+': [ '--coverage' ],
            'ldflags+': [ '--coverage' ]
          }
        ],
        [
          'simulate == "true"',
          {
            "sources+": [ "test/simulate.cc" ]
          },
          {
            "libraries": [ "-llora_pkt_fwd" ]
          }
        ]
      ]
    }
  ]
}
