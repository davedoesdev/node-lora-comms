"use strict";

module.exports = function (grunt)
{
    grunt.initConfig(
    {
        exec: {
            build: {
                cmd: 'node-gyp build --debug'
            }
        }
    });

    grunt.loadNpmTasks('grunt-exec');

    grunt.registerTask('build', 'exec:build');
};
